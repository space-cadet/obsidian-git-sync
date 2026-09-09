import { DataAdapter, Stat } from "obsidian";
import { Buffer } from "buffer";
import * as git from "isomorphic-git";

const browserGlobal = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
browserGlobal.Buffer ??= Buffer;

export type RepositoryState =
	| { kind: "checking"; repositoryPath: string }
	| { kind: "missing"; repositoryPath: string }
	| { kind: "ready"; repositoryPath: string; branch: string; head: string | null }
	| { kind: "error"; repositoryPath: string; message: string };

export interface ChangedFile {
	path: string;
	status: string;
	staged: boolean;
}

export interface CommitAuthor {
	name: string;
	email: string;
}

export interface CommitFileChange {
	path: string;
	status: "Added" | "Modified" | "Deleted";
}

export interface LocalCommit {
	oid: string;
	message: string;
	author: CommitAuthor & {
		timestamp: number;
	};
	committer: CommitAuthor & {
		timestamp: number;
	};
	changes: CommitFileChange[];
	changesLoaded: boolean;
}

export interface CommitHistory {
	commits: LocalCommit[];
	hasMore: boolean;
}

export interface RemoteCommitHistory {
	commits: LocalCommit[];
	available: boolean;
	hasMore: boolean;
}

export function validateRepositoryPath(value: string): string | null {
	const path = value.trim();
	if (!path) return "Enter a repository path.";
	if (path.startsWith("/")) return "Use a vault-relative repository path.";
	if (path.split("/").indexOf("..") !== -1) return "Repository paths cannot leave the vault.";
	return null;
}

export async function inspectLocalRepository(
	adapter: DataAdapter,
	repositoryPath: string,
): Promise<RepositoryState> {
	const path = normalizedRepositoryPath(repositoryPath);
	const headPath = pathInRepository(path, ".git/HEAD");

	try {
		if (!(await adapter.exists(headPath))) {
			return { kind: "missing", repositoryPath: path };
		}

		const head = (await adapter.read(headPath)).trim();
		if (head.startsWith("ref: ")) {
			const ref = head.slice("ref: ".length);
			const branch = ref.replace("refs/heads/", "");
			const refPath = pathInRepository(path, `.git/${ref}`);
			const commit = (await adapter.exists(refPath))
				? (await adapter.read(refPath)).trim()
				: null;
			return { kind: "ready", repositoryPath: path, branch, head: commit };
		}

		return {
			kind: "ready",
			repositoryPath: path,
			branch: "Detached HEAD",
			head,
		};
	} catch (error) {
		return {
			kind: "error",
			repositoryPath: path,
			message: error instanceof Error ? error.message : "Unable to read the repository.",
		};
	}
}

export async function readChanges(
	adapter: DataAdapter,
	repositoryPath: string,
	filepaths?: string[],
): Promise<ChangedFile[]> {
	const fs = new ObsidianGitFs(adapter);
	const dir = normalizedRepositoryPath(repositoryPath);
	const matrix = await git.statusMatrix({
		fs,
		dir,
		refresh: false,
		...(filepaths ? { filepaths } : {}),
	});
	return matrix
		.filter(([, head, workdir, stage]) => head !== workdir || head !== stage)
		.map(([path, head, workdir, stage]) => ({
			path,
			status: statusLabel(head, workdir, stage),
			staged: head === stage ? false : stage === workdir,
		}));
}

export async function stageFile(adapter: DataAdapter, repositoryPath: string, path: string | string[]): Promise<void> {
	await git.add({ fs: new ObsidianGitFs(adapter), dir: normalizedRepositoryPath(repositoryPath), filepath: path });
}

export async function unstageFile(adapter: DataAdapter, repositoryPath: string, path: string): Promise<void> {
	await git.resetIndex({ fs: new ObsidianGitFs(adapter), dir: normalizedRepositoryPath(repositoryPath), filepath: path });
}

export async function unstageFiles(adapter: DataAdapter, repositoryPath: string, paths: string[]): Promise<void> {
	const fs = new ObsidianGitFs(adapter);
	const dir = normalizedRepositoryPath(repositoryPath);
	const cache = {};
	for (const path of paths) {
		await git.resetIndex({ fs, dir, filepath: path, cache });
	}
}

export async function removeFile(adapter: DataAdapter, repositoryPath: string, path: string): Promise<void> {
	await git.remove({ fs: new ObsidianGitFs(adapter), dir: normalizedRepositoryPath(repositoryPath), filepath: path });
}

export async function addToGitignore(adapter: DataAdapter, repositoryPath: string, path: string): Promise<void> {
	const repository = normalizedRepositoryPath(repositoryPath);
	const gitignorePath = repository === "." ? ".gitignore" : `${repository}/.gitignore`;
	const current = await adapter.exists(gitignorePath) ? await adapter.read(gitignorePath) : "";
	const normalizedPath = path.trim().replace(/^\.\/+/, "");
	if (!normalizedPath) throw new Error("The file path is empty.");

	const lines = current.split(/\r?\n/);
	if (lines.some((line) => line.trim() === normalizedPath)) return;
	const prefix = current && !current.endsWith("\n") ? `${current}\n` : current;
	await adapter.write(gitignorePath, `${prefix}${normalizedPath}\n`);
}

export async function commitChanges(
	adapter: DataAdapter,
	repositoryPath: string,
	message: string,
	author: CommitAuthor,
): Promise<string> {
	return git.commit({
		fs: new ObsidianGitFs(adapter),
		dir: normalizedRepositoryPath(repositoryPath),
		message,
		author,
	});
}

export async function readCommits(
	adapter: DataAdapter,
	repositoryPath: string,
	depth = 100,
): Promise<CommitHistory> {
	return readCommitsAtRef(adapter, repositoryPath, "HEAD", depth);
}

export async function readCommitChanges(
	adapter: DataAdapter,
	repositoryPath: string,
	commitOid: string,
): Promise<CommitFileChange[]> {
	let result: Awaited<ReturnType<typeof git.log>>;
	try {
		result = await git.log({
			fs: new ObsidianGitFs(adapter),
			dir: normalizedRepositoryPath(repositoryPath),
			ref: commitOid,
			depth: 1,
			includeChanges: true,
		});
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "NoCommitError") return [];
		throw error;
	}

	return mapCommitChanges(result[0]?.commit.changes);
}

export async function readRemoteCommits(
	adapter: DataAdapter,
	repositoryPath: string,
	branchName: string,
	depth = 100,
): Promise<RemoteCommitHistory> {
	const fs = new ObsidianGitFs(adapter);
	const dir = normalizedRepositoryPath(repositoryPath);
	const branch = branchName.trim();
	if (!branch) return { commits: [], available: false, hasMore: false };

	const branches = await git.listBranches({ fs, dir, remote: "origin" });
	if (branches.indexOf(branch) === -1) return { commits: [], available: false, hasMore: false };
	const history = await readCommitsAtRef(adapter, repositoryPath, `refs/remotes/origin/${branch}`, depth);

	return {
		commits: history.commits,
		available: true,
		hasMore: history.hasMore,
	};
}

async function readCommitsAtRef(
	adapter: DataAdapter,
	repositoryPath: string,
	ref: string,
	depth: number,
): Promise<CommitHistory> {
	let result: Awaited<ReturnType<typeof git.log>>;
	try {
		result = await git.log({
			fs: new ObsidianGitFs(adapter),
			dir: normalizedRepositoryPath(repositoryPath),
			ref,
			depth: depth + 1,
			includeChanges: false,
		});
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "NoCommitError") {
			return { commits: [], hasMore: false };
		}
		throw error;
	}

	return {
		commits: result.slice(0, depth).map(({ oid, commit }) => ({
			oid,
			message: commit.message,
			author: {
				name: commit.author.name,
				email: commit.author.email,
				timestamp: commit.author.timestamp,
			},
			committer: {
				name: commit.committer.name,
				email: commit.committer.email,
				timestamp: commit.committer.timestamp,
			},
			changes: [],
			changesLoaded: false,
		})),
		hasMore: result.length > depth,
	};
}

function mapCommitChanges(changes: Awaited<ReturnType<typeof git.log>>[number]["commit"]["changes"]): CommitFileChange[] {
	return (changes ?? []).map(([newOid, oldOid, path]) => ({
		path: String(path),
		status: newOid === null ? "Deleted" : oldOid === null ? "Added" : "Modified",
	}));
}

function normalizedRepositoryPath(path: string): string {
	const trimmed = path.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
	return trimmed || ".";
}

function pathInRepository(repositoryPath: string, path: string): string {
	return repositoryPath === "." ? path : `${repositoryPath}/${path}`;
}

function statusLabel(head: number, workdir: number, stage: number): string {
	if (head === 0 && workdir === 2 && stage === 0) return "Untracked";
	if (head === 0 && stage === 2) return workdir === 2 ? "Added" : "Added, deleted";
	if (head === 1 && workdir === 0 && stage === 1) return "Deleted";
	if (head === 1 && stage === 0) return "Deleted";
	if (head === 1 && workdir === 2 && stage === 1) return "Modified";
	if (head === 1 && stage === 2) return workdir === 2 ? "Modified" : "Deleted";
	return "Changed";
}

export class ObsidianGitFs {
	// Obsidian's mobile vault index can briefly retain a path after the backing
	// file has been moved or deleted. Validate listed entries once and reuse the
	// result for isomorphic-git's immediately following lstat call.
	private readonly validatedStats = new Map<string, Stat>();

	readonly promises = {
		readFile: async (path: string, options?: string | { encoding?: string }): Promise<Uint8Array | string> => {
			try {
				const encoding = typeof options === "string" ? options : options?.encoding;
				if (encoding === "utf8" || encoding === "utf-8") {
					return this.adapter.read(this.normalized(path));
				}
				return new Uint8Array(await this.adapter.readBinary(this.normalized(path)));
			} catch (error) {
				throw this.fileSystemError(path, error);
			}
		},
		writeFile: async (path: string, data: Uint8Array | string): Promise<void> => {
			const normalizedPath = this.normalized(path);
			try {
				if (typeof data === "string") {
					await this.adapter.write(normalizedPath, data);
					return;
				}
				await this.adapter.writeBinary(
					normalizedPath,
					data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
				);
			} catch (error) {
				throw this.adapterOperationError("write", normalizedPath, error);
			}
		},
		unlink: async (path: string): Promise<void> => {
			const normalizedPath = this.normalized(path);
			try {
				await this.adapter.remove(normalizedPath);
			} catch (error) {
				throw this.adapterOperationError("remove", normalizedPath, error);
			}
		},
		readdir: async (path: string): Promise<string[]> => {
			try {
				const listed = await this.adapter.list(this.normalized(path));
				const directory = this.normalized(path);
				const stripDirectoryPrefix = (entry: string): string => {
					const normalizedEntry = entry.replace(/^\.\//, "");
					if (directory !== "." && normalizedEntry.startsWith(`${directory}/`)) {
						return normalizedEntry.slice(directory.length + 1);
					}
					return normalizedEntry;
				};
				const entries = [...listed.files, ...listed.folders];
				const existingEntries = await Promise.all(
					entries.map(async (entry) => {
						const relativePath = stripDirectoryPrefix(entry);
						const candidatePath = directory === "." ? relativePath : `${directory}/${relativePath}`;
						try {
							const stat = await this.adapter.stat(candidatePath);
							return stat ? { relativePath, candidatePath, stat } : null;
						} catch (error) {
							if (isMissingPathError(error)) return null;
							throw error;
						}
					}),
				);

				for (const entry of existingEntries) {
					if (entry) this.validatedStats.set(entry.candidatePath, entry.stat);
				}
				return existingEntries
					.filter((entry): entry is { relativePath: string; candidatePath: string; stat: Stat } => entry !== null)
					.map((entry) => entry.relativePath);
			} catch (error) {
				throw this.fileSystemError(path, error);
			}
		},
		mkdir: async (path: string): Promise<void> => {
			const normalizedPath = this.normalized(path);
			try {
				await this.adapter.mkdir(normalizedPath);
			} catch (error) {
				throw this.adapterOperationError("create folder", normalizedPath, error);
			}
		},
		rmdir: async (path: string): Promise<void> => {
			const normalizedPath = this.normalized(path);
			try {
				await this.adapter.rmdir(normalizedPath, false);
			} catch (error) {
				throw this.adapterOperationError("remove folder", normalizedPath, error);
			}
		},
		stat: async (path: string): Promise<git.Stat> => this.stat(path),
		lstat: async (path: string): Promise<git.Stat> => this.stat(path),
		readlink: async (path: string): Promise<string> => {
			throw this.unsupportedLinkError(path);
		},
		symlink: async (_target: string, path: string): Promise<void> => {
			throw this.unsupportedLinkError(path);
		},
	};

	constructor(private readonly adapter: DataAdapter) {}

	private normalized(path: string): string {
		return path.replace(/^\.\//, "").replace(/\\/g, "/");
	}

	private async stat(path: string): Promise<git.Stat> {
		const normalizedPath = this.normalized(path);
		const validated = this.validatedStats.get(normalizedPath);
		const value = validated ?? await this.readStat(normalizedPath, path);
		if (validated) this.validatedStats.delete(normalizedPath);
		if (!value) {
			throw this.fileSystemError(path);
		}
		const directory = value.type === "folder";
		return {
			ctimeSeconds: Math.floor(value.ctime / 1000),
			ctimeNanoseconds: 0,
			mtimeSeconds: Math.floor(value.mtime / 1000),
			mtimeNanoseconds: 0,
			dev: 0,
			ino: 0,
			mode: directory ? 0o040000 : 0o100644,
			uid: 0,
			gid: 0,
			size: value.size,
			isDirectory: () => directory,
			isFile: () => !directory,
			isSymbolicLink: () => false,
		} as git.Stat;
	}

	private async readStat(path: string, originalPath: string): Promise<Stat | null> {
		try {
			return await this.adapter.stat(path);
		} catch (error) {
			throw this.fileSystemError(originalPath, error);
		}
	}

	private fileSystemError(path: string, cause?: unknown): Error & { code: string } {
		if (cause && typeof cause === "object" && "code" in cause) {
			return cause as Error & { code: string };
		}
		const error = new Error(`ENOENT: no such file or directory, '${path}'`) as Error & { code: string };
		error.code = "ENOENT";
		return error;
	}

	private unsupportedLinkError(path: string): Error & { code: string } {
		const error = new Error(`EINVAL: symbolic links are not supported for '${path}'`) as Error & { code: string };
		error.code = "EINVAL";
		return error;
	}

	private adapterOperationError(operation: string, path: string, cause: unknown): Error & { code?: string } {
		const record = cause && typeof cause === "object" ? cause as Record<string, unknown> : null;
		const code = record && typeof record.code === "string" ? record.code : "";
		const message = cause instanceof Error
			? cause.message
			: record && typeof record.message === "string"
				? record.message
				: String(cause ?? "adapter error");
		const detail = message || code || "adapter error";
		const error = new Error(`${operation} '${path}' failed: ${detail}`) as Error & { code?: string };
		if (code) error.code = code;
		return error;
	}
}

function isMissingPathError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as { code?: unknown; message?: unknown };
	return candidate.code === "ENOENT" || /no such file|not found/i.test(String(candidate.message ?? ""));
}
