import { DataAdapter, requestUrl } from "obsidian";
import * as git from "isomorphic-git";
import { ObsidianGitFs, validateRepositoryPath } from "./repository";

export const REMOTE_TOKEN_SECRET_ID = "git-sync-remote-token";

export interface RemoteCredential {
	username: string;
	token: string;
}

export interface RemoteAuthor {
	name: string;
	email: string;
}

export interface RemoteConnectionInfo {
	remoteUrl: string;
	defaultBranch: string | null;
	branches: string[];
	capabilities: string[];
}

export interface RemoteProgressEvent {
	phase: string;
	loaded: number;
	total: number;
}

export interface RemoteOperationResult {
	summary: string;
	details: string[];
}

export interface RemoteRepositoryOptions {
	adapter: DataAdapter;
	repositoryPath: string;
	remoteUrl: string;
	branchName: string;
	credential: RemoteCredential | null;
	author: RemoteAuthor | null;
	onDiagnostic?: (message: string) => void;
	onPhase?: (phase: string) => void;
	onProgress?: (event: RemoteProgressEvent) => void | Promise<void>;
	onMessage?: (message: string) => void | Promise<void>;
}

export async function testRemoteConnection(
	remoteUrl: string,
	credential: RemoteCredential | null,
): Promise<RemoteConnectionInfo> {
	const url = validateRemoteUrl(remoteUrl);
	const info = await git.getRemoteInfo({
		http: obsidianHttp,
		url,
		onAuth: (_url, auth) => credential
			? { ...auth, username: credential.username, password: credential.token }
			: auth,
	});

	return {
		remoteUrl: url,
		defaultBranch: info.HEAD ?? null,
		branches: Object.keys(info.heads ?? {}).sort(),
		capabilities: info.capabilities,
	};
}

export async function fetchRepository(options: RemoteRepositoryOptions): Promise<RemoteOperationResult> {
	const { fs, dir, url, branch } = await prepareRemote(options);
	const previousRemoteHead = await resolveOptionalRef(fs, dir, `refs/remotes/origin/${branch}`);
	phase(options, `Contacting origin/${branch}…`);
	diagnostic(options, `Fetch: requesting origin/${branch} from ${url}.`);
	const result = await git.fetch({
		fs,
		http: obsidianHttp,
		dir,
		remote: "origin",
		url,
		ref: branch,
		singleBranch: true,
		onAuth: authCallback(options.credential),
		onProgress: options.onProgress,
		onMessage: options.onMessage,
	});
	phase(options, "Applying fetched history…");
	diagnostic(options, `Fetch: received ${result.fetchHead ? result.fetchHead.slice(0, 7) : "no commit"}.`);
	const fetchedHead = result.fetchHead;
	return {
		summary: fetchedHead && fetchedHead !== previousRemoteHead
			? `Updated origin/${branch} to ${shortOid(fetchedHead)}.`
			: "Already up to date.",
		details: [
			`From ${redactRemoteText(url)}`,
			fetchedHead ? `origin/${branch} -> ${shortOid(fetchedHead)}` : `No commits received from origin/${branch}.`,
		],
	};
}

export async function pullRepository(options: RemoteRepositoryOptions): Promise<RemoteOperationResult> {
	const { fs, dir, url, branch } = await prepareRemote(options);
	if (!options.author?.name || !options.author.email) {
		throw new Error("Set your commit name and email before pulling.");
	}
	const previousLocalHead = await resolveOptionalRef(fs, dir, branch);
	phase(options, `Contacting origin/${branch}…`);
	diagnostic(options, `Pull: requesting origin/${branch} from ${url}.`);
	await git.pull({
		fs,
		http: obsidianHttp,
		dir,
		remote: "origin",
		url,
		ref: branch,
		singleBranch: true,
		fastForwardOnly: true,
		author: options.author,
		committer: options.author,
		onAuth: authCallback(options.credential),
		onProgress: options.onProgress,
		onMessage: options.onMessage,
	});
	phase(options, "Updating local branch…");
	diagnostic(options, `Pull: completed fast-forward check for ${branch}.`);
	const currentLocalHead = await resolveOptionalRef(fs, dir, branch);
	const updated = currentLocalHead && currentLocalHead !== previousLocalHead;
	return {
		summary: updated
			? `Fast-forwarded ${branch} to ${shortOid(currentLocalHead)}.`
			: "Already up to date.",
		details: updated && previousLocalHead
			? [`Local ${branch}: ${shortOid(previousLocalHead)}..${shortOid(currentLocalHead)}`]
			: [`Local ${branch}: ${shortOid(currentLocalHead)}`],
	};
}

export async function forcePullRepository(options: RemoteRepositoryOptions): Promise<RemoteOperationResult> {
	const { fs, dir, url, branch } = await prepareRemote(options);
	phase(options, `Contacting origin/${branch}…`);
	diagnostic(options, `Force pull: requesting origin/${branch} from ${url}.`);
	const result = await git.fetch({
		fs,
		http: obsidianHttp,
		dir,
		remote: "origin",
		url,
		ref: branch,
		singleBranch: true,
		onAuth: authCallback(options.credential),
		onProgress: options.onProgress,
		onMessage: options.onMessage,
	});
	const remoteHead = result.fetchHead ?? await resolveOptionalRef(fs, dir, `refs/remotes/origin/${branch}`);
	if (!remoteHead) throw new Error(`Remote branch origin/${branch} has no commits.`);

	phase(options, "Discarding local changes and updating branch…");
	await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: remoteHead, force: true });
	await git.checkout({ fs, dir, ref: branch, force: true });
	diagnostic(options, `Force pull: reset ${branch} to ${shortOid(remoteHead)}.`);

	return {
		summary: `Reset ${branch} to origin/${branch} at ${shortOid(remoteHead)}.`,
		details: [
			`From ${redactRemoteText(url)}`,
			`Local ${branch} -> ${shortOid(remoteHead)}`,
		],
	};
}

export async function pushRepository(options: RemoteRepositoryOptions): Promise<RemoteOperationResult> {
	return pushRepositoryWithMode(options, false);
}

export async function forcePushRepository(options: RemoteRepositoryOptions): Promise<RemoteOperationResult> {
	return pushRepositoryWithMode(options, true);
}

async function pushRepositoryWithMode(
	options: RemoteRepositoryOptions,
	force: boolean,
): Promise<RemoteOperationResult> {
	const { fs, dir, url, branch } = await prepareRemote(options);
	const pushPlan: PushPlan = { localOid: "", remoteOid: "" };
	phase(options, "Preparing local pack and contacting remote…");
	diagnostic(options, `${force ? "Force push" : "Push"}: sending ${branch} to ${url}.`);
	const result = await git.push({
		fs,
		http: obsidianHttp,
		dir,
		remote: "origin",
		url,
		ref: branch,
		remoteRef: branch,
		force,
		onAuth: authCallback(options.credential),
		onProgress: options.onProgress,
		onMessage: options.onMessage,
		onPrePush: ({ localRef, remoteRef }) => {
			pushPlan.localOid = localRef.oid;
			pushPlan.remoteOid = remoteRef.oid;
			return true;
		},
	});
	phase(options, "Finalizing push…");
	diagnostic(options, `Push: server response ${result.ok ? "accepted" : result.error ?? "rejected"}.`);
	if (result.error) throw new Error(result.error);

	const details = [`To ${redactRemoteText(url)}`];
	if (pushPlan.localOid && pushPlan.localOid === pushPlan.remoteOid) {
		details.push("Everything up-to-date.");
	} else if (pushPlan.localOid && isZeroOid(pushPlan.remoteOid)) {
		details.push(`* [new branch] ${branch} -> ${branch}`);
	} else if (pushPlan.localOid) {
		details.push(`   ${shortOid(pushPlan.remoteOid)}..${shortOid(pushPlan.localOid)}  ${branch} -> ${branch}`);
	}

	return {
		summary: pushPlan.localOid && pushPlan.localOid === pushPlan.remoteOid
			? "Everything up-to-date."
			: `${force ? "Force-pushed" : "Pushed"} ${branch} to origin.`,
		details,
	};
}

export async function cloneRepository(options: RemoteRepositoryOptions): Promise<RemoteOperationResult> {
	const dir = validateRepositoryDirectory(options.repositoryPath);
	const url = validateRemoteUrl(options.remoteUrl);
	const branch = validateBranchName(options.branchName);
	const fs = new ObsidianGitFs(options.adapter);
	const listing = await listDirectory(options.adapter, dir);
	if (listing && (listing.files.length > 0 || listing.folders.length > 0)) {
		throw new Error(`The clone destination '${dir}' is not empty.`);
	}

	phase(options, "Downloading repository…");
	diagnostic(options, `Clone: requesting ${branch} from ${url} into ${dir}.`);
	await git.clone({
		fs,
		http: obsidianHttp,
		dir,
		url,
		ref: branch,
		singleBranch: true,
		onAuth: authCallback(options.credential),
		onProgress: options.onProgress,
		onMessage: options.onMessage,
	});
	phase(options, "Checking out repository files…");
	diagnostic(options, `Clone: completed repository setup in ${dir}.`);
	return {
		summary: `Cloned ${branch} from origin.`,
		details: [`Repository ready at ${dir}.`],
	};
}

async function prepareRemote(options: RemoteRepositoryOptions): Promise<{
	fs: ObsidianGitFs;
	dir: string;
	url: string;
	branch: string;
}> {
	phase(options, "Validating remote settings…");
	const dir = validateRepositoryDirectory(options.repositoryPath);
	const url = validateRemoteUrl(options.remoteUrl);
	const branch = validateBranchName(options.branchName);
	const fs = new ObsidianGitFs(options.adapter);
	phase(options, "Configuring remote connection…");
	diagnostic(options, `Remote setup: validated ${dir} and branch ${branch}.`);
	await git.addRemote({ fs, dir, remote: "origin", url, force: true });
	diagnostic(options, `Remote setup: origin configured for ${url}.`);
	return { fs, dir, url, branch };
}

function validateRepositoryDirectory(value: string): string {
	const error = validateRepositoryPath(value);
	if (error) throw new Error(error);
	const path = value.trim().replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";
	if (path === ".") return path;
	return path;
}

function validateBranchName(value: string): string {
	const branch = value.trim();
	if (!branch) throw new Error("Enter a branch before using a remote operation.");
	if (branch.startsWith("-") || branch.includes("..") || branch.includes(" ")) {
		throw new Error("Use a simple branch name without spaces or '..'.");
	}
	return branch;
}

interface PushPlan {
	localOid: string;
	remoteOid: string;
}

async function resolveOptionalRef(fs: ObsidianGitFs, dir: string, ref: string): Promise<string | null> {
	try {
		return await git.resolveRef({ fs, dir, ref });
	} catch {
		return null;
	}
}

function isZeroOid(value: string): boolean {
	return /^0{40}$/.test(value);
}

function shortOid(value: string | null): string {
	return value ? value.slice(0, 7) : "none";
}

async function listDirectory(adapter: DataAdapter, path: string): Promise<{ files: string[]; folders: string[] } | null> {
	try {
		return await adapter.list(path);
	} catch {
		return null;
	}
}

function authCallback(credential: RemoteCredential | null): (url: string, auth: git.GitAuth) => git.GitAuth {
	return (_url, auth) => credential
		? { ...auth, username: credential.username, password: credential.token }
		: auth;
}

function diagnostic(options: RemoteRepositoryOptions, message: string): void {
	options.onDiagnostic?.(`[remote] ${redactRemoteText(message)}`);
}

function phase(options: RemoteRepositoryOptions, message: string): void {
	options.onPhase?.(message);
	diagnostic(options, message);
}

function redactRemoteText(value: string): string {
	return value
		.replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, "$1[redacted]@")
		.replace(/\b(token|password|authorization|bearer)\s*[:=]\s*\S+/gi, "$1: [redacted]");
}

function validateRemoteUrl(value: string): string {
	const url = value.trim();
	if (!url) throw new Error("Enter a remote URL before testing the connection.");
	if (!/^https?:\/\//i.test(url)) {
		throw new Error("Use an HTTP or HTTPS Git remote URL.");
	}
	return url;
}

const obsidianHttp: any = {
	request: async (request: any): Promise<any> => {
		const response = await requestUrl({
			url: request.url,
			method: request.method,
			headers: request.headers,
			body: request.body ? await collectBody(request.body) : undefined,
			throw: false,
		});

		return {
			url: request.url,
			method: request.method,
			headers: response.headers,
			statusCode: response.status,
			statusMessage: response.status === 200 ? "OK" : `HTTP ${response.status}`,
			body: responseBody(response.arrayBuffer),
		};
	},
};

const ASYNC_ITERATOR = (Symbol as unknown as { asyncIterator: symbol }).asyncIterator;

async function collectBody(body: any): Promise<ArrayBuffer> {
	const chunks: Uint8Array[] = [];
	if (Array.isArray(body)) {
		for (const chunk of body) chunks.push(toUint8Array(chunk));
	} else if (body && typeof body[ASYNC_ITERATOR] === "function") {
		for await (const chunk of body) chunks.push(toUint8Array(chunk));
	} else if (body && typeof body.next === "function") {
		while (true) {
			const result = await body.next();
			if (result.done) break;
			if (result.value) chunks.push(toUint8Array(result.value));
		}
	} else {
		throw new Error("Git HTTP request body is not readable.");
	}

	return combineChunks(chunks);
}

function toUint8Array(value: Uint8Array | ArrayBuffer): Uint8Array {
	return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function combineChunks(chunks: Uint8Array[]): ArrayBuffer {
	let size = 0;
	for (const chunk of chunks) size += chunk.byteLength;

	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result.buffer;
}

function responseBody(buffer: ArrayBuffer): any {
	let consumed = false;
	return {
		next: async () => {
			if (consumed) return { done: true, value: undefined };
			consumed = true;
			return { done: false, value: new Uint8Array(buffer) };
		},
		[ASYNC_ITERATOR]() {
			return this;
		},
	};
}
