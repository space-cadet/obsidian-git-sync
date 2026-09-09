import {
	App,
	ItemView,
	Menu,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	setIcon,
	WorkspaceLeaf,
} from "obsidian";
import { GIT_BRANCH, GIT_COMMIT_HASH } from "./build-info";
import {
	ChangedFile,
	CommitFileChange,
	addToGitignore,
	commitChanges,
	inspectLocalRepository,
	LocalCommit,
	readCommits,
	readCommitChanges,
	readRemoteCommits,
	readChanges,
	removeFile,
	RepositoryState,
	stageFile,
	unstageFile,
	unstageFiles,
} from "./repository";
import { AvailableBuildsModal, PluginUpdater, UpdateAvailableModal } from "./updater/PluginUpdater";
import {
	cloneRepository,
	fetchRepository,
	forcePullRepository,
	forcePushRepository,
	pushRepository,
	pullRepository,
	REMOTE_TOKEN_SECRET_ID,
	RemoteCredential,
	RemoteOperationResult,
	RemoteProgressEvent,
	testRemoteConnection,
} from "./remote";

const VIEW_TYPE_GIT_SYNC = "git-sync-sidebar";
const PLUGIN_DATA_FORMAT = "obsidian-git-sync";
const PLUGIN_DATA_SCHEMA_VERSION = 1 as const;
const ACTIVITY_PAGE_SIZE = 100;
const MAX_ACTIVITY_ENTRIES = 1000;
const ACTIVITY_LOG_COMPACTION_THRESHOLD = MAX_ACTIVITY_ENTRIES + ACTIVITY_PAGE_SIZE;
const COMMIT_PAGE_SIZE = 100;

interface GitSyncSettings {
	repositoryPath: string;
	remoteUrl: string;
	remoteUsername: string;
	branchName: string;
	authorName: string;
	authorEmail: string;
	checkForUpdates: boolean;
	updateChannel: "stable" | "dev";
	autoUpdate: boolean;
	lastUpdateCheck: number;
	includeActivityInExports: boolean;
}

interface ActivityEntry {
	message: string;
	timestamp: number;
	level: ActivityLevel;
}

type ActivityLevel = "DEBUG" | "INFO" | "METRIC" | "ERROR";
type CommitSource = "local" | "remote";
type ChangeSection = "staged" | "uncommitted";
type ChangeStatusFilter = "Untracked" | "Added" | "Modified" | "Deleted";
type ChangeSort = "path-asc" | "path-desc" | "status-path" | "folder-name";

const CHANGE_STATUS_FILTERS: ChangeStatusFilter[] = ["Untracked", "Added", "Modified", "Deleted"];
const CHANGE_SORTS: Array<{ value: ChangeSort; label: string }> = [
	{ value: "path-asc", label: "Path (A–Z)" },
	{ value: "path-desc", label: "Path (Z–A)" },
	{ value: "status-path", label: "Status, then path" },
	{ value: "folder-name", label: "Folder, then name" },
];

interface LongPressSelectionState {
	section: ChangeSection;
	path: string;
	visibleChanges: ChangedFile[];
	pointerId: number;
	startX: number;
	startY: number;
	timer: number;
	active: boolean;
	suppressClick: boolean;
}

interface StoredPluginData {
	format: typeof PLUGIN_DATA_FORMAT;
	schemaVersion: typeof PLUGIN_DATA_SCHEMA_VERSION;
	settings: GitSyncSettings;
}

interface DecodedPluginData {
	settings: Partial<GitSyncSettings>;
	activity: unknown;
	legacy: boolean;
}

const DEFAULT_SETTINGS: GitSyncSettings = {
	repositoryPath: ".",
	remoteUrl: "",
	remoteUsername: "git",
	branchName: "main",
	authorName: "",
	authorEmail: "",
	checkForUpdates: true,
	updateChannel: "dev",
	autoUpdate: false,
	lastUpdateCheck: 0,
	includeActivityInExports: false,
};

export default class GitSyncPlugin extends Plugin {
	settings: GitSyncSettings = DEFAULT_SETTINGS;
	private activity: ActivityEntry[] = [];
	private persistedActivity: ActivityEntry[] = [];
	private activityLogEntryCount = 0;
	private activityWrite: Promise<void> = Promise.resolve();
	private updater: PluginUpdater | null = null;
	private dataSave: Promise<void> = Promise.resolve();
	private remoteOperationQueue: Promise<void> = Promise.resolve();
	private settingsSaveTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE_GIT_SYNC,
			(leaf) => new GitSyncView(leaf, this),
		);
		this.addRibbonIcon("git-branch", "Open Git Sync", () => {
			void this.activateView();
		});
		this.addCommand({
			id: "open-git-sync",
			name: "Open Git Sync",
			callback: () => void this.activateView(),
		});
		this.addSettingTab(new GitSyncSettingTab(this.app, this));
		this.updater = new PluginUpdater(this.app, this.manifest.id);
		this.addCommand({
			id: "check-for-updates",
			name: "Check for plugin updates",
			callback: () => void this.checkForUpdates(true),
		});
		this.recordActivity("Git Sync started.");

		if (this.settings.checkForUpdates && Date.now() - this.settings.lastUpdateCheck > 24 * 60 * 60 * 1000) {
			void this.checkForUpdates(false);
		}
	}

	onunload(): void {
		if (this.settingsSaveTimer !== null) {
			window.clearTimeout(this.settingsSaveTimer);
			this.settingsSaveTimer = null;
		}
		void this.persistData();
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_GIT_SYNC);
	}

	async activateView(): Promise<void> {
		const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_GIT_SYNC)[0];
		if (existingLeaf) {
			await this.app.workspace.revealLeaf(existingLeaf);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			new Notice("Git Sync could not open its sidebar.");
			return;
		}

		await leaf.setViewState({ type: VIEW_TYPE_GIT_SYNC, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		const decoded = decodePluginData(await this.loadData(), true);
		this.settings = normalizeSettings(decoded.settings);
		const logActivity = await this.loadActivityLog();
		const legacyActivity = normalizeActivity(decoded.activity);
		this.activity = mergeActivity(logActivity, legacyActivity);
		if (legacyActivity.length > 0) await this.replaceActivityLog(this.activity);
		if (decoded.legacy || legacyActivity.length > 0) await this.persistData();
	}

	async saveSettings(): Promise<void> {
		await this.persistData();
		this.refreshViews();
	}

	private persistData(): Promise<void> {
		const data = this.createStoredData();
		this.dataSave = this.dataSave
			.catch(() => undefined)
			.then(() => this.saveData(data));
		return this.dataSave;
	}

	private createStoredData(): StoredPluginData {
		return {
			format: PLUGIN_DATA_FORMAT,
			schemaVersion: PLUGIN_DATA_SCHEMA_VERSION,
			settings: { ...this.settings },
		};
	}

	createExportData(includeActivity = this.settings.includeActivityInExports): string {
		return JSON.stringify({
			...this.createStoredData(),
			activity: includeActivity ? this.activity.slice(0, MAX_ACTIVITY_ENTRIES) : [],
			exportedAt: new Date().toISOString(),
			activityIncluded: includeActivity,
		}, null, 2);
	}

	async exportDataToVault(): Promise<string> {
		const path = `git-sync-data-${formatFileTimestamp(new Date())}.json`;
		await this.app.vault.adapter.write(path, this.createExportData());
		this.recordActivity(`Plugin data exported to ${path}.`);
		return path;
	}

	async importData(json: string): Promise<void> {
		let decoded: DecodedPluginData;
		try {
			decoded = decodePluginData(JSON.parse(json), true, true);
		} catch (error) {
			throw error instanceof Error ? error : new Error("The selected file is not valid Git Sync data.");
		}

		if (!window.confirm("Import Git Sync settings and activity? Existing plugin data will be replaced.")) return;
		this.settings = normalizeSettings(decoded.settings);
		this.activity = normalizeActivity(decoded.activity);
		await this.replaceActivityLog(this.activity);
		await this.persistData();
		this.refreshViews();
		this.recordActivity("Plugin data imported.");
		new Notice("Plugin data imported. Remote credentials were left unchanged.");
	}

	scheduleSettingsSave(): void {
		if (this.settingsSaveTimer !== null) window.clearTimeout(this.settingsSaveTimer);
		this.settingsSaveTimer = window.setTimeout(() => {
			this.settingsSaveTimer = null;
			void this.saveSettings();
		}, 250);
	}

	recordActivity(message: string, level: ActivityLevel = "INFO"): void {
		const entry = { message, timestamp: Date.now(), level };
		this.activity.unshift(entry);
		this.activity = this.activity.slice(0, MAX_ACTIVITY_ENTRIES);
		void this.enqueueActivityWrite(async () => {
			await this.app.vault.adapter.append(this.activityLogPath(), `${serializeActivityEntry(entry)}\n`);
			this.persistedActivity.unshift(entry);
			this.persistedActivity = this.persistedActivity.slice(0, MAX_ACTIVITY_ENTRIES);
			this.activityLogEntryCount += 1;
			if (this.activityLogEntryCount > ACTIVITY_LOG_COMPACTION_THRESHOLD) {
				await this.writeActivityLog(this.persistedActivity);
				this.activityLogEntryCount = this.persistedActivity.length;
			}
		}).catch(() => undefined);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GIT_SYNC)) {
			const view = leaf.view;
			if (view instanceof GitSyncView) view.refreshActivity();
		}
	}

	getActivity(): readonly ActivityEntry[] {
		return this.activity;
	}

	private activityLogPath(): string {
		const pluginDirectory = this.manifest.dir?.replace(/\/+$/, "")
			|| `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		return `${pluginDirectory}/activity.log`;
	}

	private async loadActivityLog(): Promise<ActivityEntry[]> {
		const path = this.activityLogPath();
		if (!(await this.app.vault.adapter.exists(path))) {
			this.persistedActivity = [];
			this.activityLogEntryCount = 0;
			return [];
		}

		const raw = await this.app.vault.adapter.read(path);
		const entries = raw.split(/\r?\n/)
			.map(parseActivityEntry)
			.filter((entry): entry is ActivityEntry => entry !== null);
		this.activityLogEntryCount = entries.length;
		this.persistedActivity = entries.slice(-MAX_ACTIVITY_ENTRIES).reverse();
		return this.persistedActivity.slice();
	}

	private enqueueActivityWrite(operation: () => Promise<void>): Promise<void> {
		this.activityWrite = this.activityWrite.catch(() => undefined).then(operation);
		return this.activityWrite;
	}

	private async replaceActivityLog(entries: ActivityEntry[]): Promise<void> {
		await this.enqueueActivityWrite(async () => {
			const recent = entries.slice(0, MAX_ACTIVITY_ENTRIES);
			await this.writeActivityLog(recent);
			this.persistedActivity = recent.slice();
			this.activityLogEntryCount = recent.length;
		});
	}

	private async writeActivityLog(entries: readonly ActivityEntry[]): Promise<void> {
		const lines = entries.slice().reverse().map(serializeActivityEntry);
		await this.app.vault.adapter.write(this.activityLogPath(), lines.length > 0 ? `${lines.join("\n")}\n` : "");
	}

	getRemoteToken(): string | null {
		return this.app.secretStorage.getSecret(REMOTE_TOKEN_SECRET_ID);
	}

	getRemoteCredential(): RemoteCredential | null {
		const token = this.getRemoteToken();
		if (!token) return null;
		return {
			username: this.settings.remoteUsername.trim() || "git",
			token,
		};
	}

	saveRemoteToken(value: string): void {
		const token = value.trim();
		this.app.secretStorage.setSecret(REMOTE_TOKEN_SECRET_ID, token);
	}

	async checkRemoteConnection(): Promise<void> {
		try {
			const info = await testRemoteConnection(this.settings.remoteUrl, this.getRemoteCredential());
			const branch = info.defaultBranch ? ` Default branch: ${info.defaultBranch}.` : "";
			this.recordActivity(`Remote connection succeeded: ${info.remoteUrl}.${branch}`);
			new Notice(`Remote connection succeeded.${branch}`);
		} catch (error) {
			const detail = error instanceof Error ? error.message : "Remote connection failed.";
			this.recordActivity(`Remote connection failed: ${detail}`, "ERROR");
			new Notice(detail);
		}
	}

	async fetchRemote(): Promise<void> {
		return this.runRemoteOperation("Fetch", (modal) => fetchRepository(this.remoteRepositoryOptions(modal)));
	}

	async pullRemote(): Promise<void> {
		return this.runRemoteOperation("Pull", (modal) => pullRepository(this.remoteRepositoryOptions(modal)));
	}

	forcePullRemote(): void {
		new ConfirmActionModal(
			this.app,
			"Reset local branch to remote?",
			`This fetches origin/${this.settings.branchName} and discards local commits and tracked changes that are not on the remote branch.`,
			() => void this.runRemoteOperation("Force Pull", (modal) => forcePullRepository(this.remoteRepositoryOptions(modal))),
			"Reset to Remote",
		).open();
	}

	async pushRemote(): Promise<void> {
		return this.runRemoteOperation("Push", (modal) => pushRepository(this.remoteRepositoryOptions(modal)));
	}

	forcePushRemote(): void {
		new ConfirmActionModal(
			this.app,
			"Force push to remote?",
			`This overwrites origin/${this.settings.branchName} with the local branch and may discard commits currently on the remote.`,
			() => void this.runRemoteOperation("Force Push", (modal) => forcePushRepository(this.remoteRepositoryOptions(modal))),
			"Force Push",
		).open();
	}

	async cloneRemote(): Promise<void> {
		return this.runRemoteOperation("Clone", (modal) => cloneRepository(this.remoteRepositoryOptions(modal)));
	}

	private remoteRepositoryOptions(progressModal?: GitProgressModal) {
		return {
			adapter: this.app.vault.adapter,
			repositoryPath: this.settings.repositoryPath,
			remoteUrl: this.settings.remoteUrl,
			branchName: this.settings.branchName,
			credential: this.getRemoteCredential(),
			author: {
				name: this.settings.authorName.trim(),
				email: this.settings.authorEmail.trim(),
			},
			onDiagnostic: (message: string) => this.recordActivity(message, "DEBUG"),
			onPhase: progressModal
				? (phase: string) => progressModal.setPhase(phase)
				: undefined,
			onProgress: progressModal
				? (event: RemoteProgressEvent) => progressModal.updateProgress(event)
				: undefined,
			onMessage: progressModal
				? (message: string) => progressModal.addRemoteMessage(message)
				: undefined,
		};
	}

	private runRemoteOperation(name: string, operation: (modal: GitProgressModal) => Promise<RemoteOperationResult>): Promise<void> {
		this.recordActivity(`${name} requested.`);
		const next = this.remoteOperationQueue
			.catch(() => undefined)
			.then(async () => {
				this.recordActivity(`${name} started for ${this.settings.branchName}.`);
				const startedAt = Date.now();
				const modal = new GitProgressModal(this.app, name, this.settings.branchName, {
					onPhase: (phase) => this.recordActivity(`${name}: ${phase}.`, "DEBUG"),
					onMessage: (message) => this.recordActivity(`${name}: ${safeRemoteMessage(message)}`, "DEBUG"),
				});
				modal.open();
				try {
					const result = await operation(modal);
					this.recordActivity(`${name} completed for ${this.settings.branchName}.`);
					this.recordActivity(`${name} completed in ${formatMilliseconds(elapsedMilliseconds(startedAt))}.`, "METRIC");
					this.recordActivity(`${name}: ${result.summary}`);
					for (const detail of result.details) this.recordActivity(`${name}: ${detail}`, "DEBUG");
					if (name === "Pull" || name === "Force Pull" || name === "Clone") {
						this.refreshViews(`${name.toLowerCase()}-metadata-refresh`, false);
					} else {
						this.refreshRemoteHistoryViews(`${name.toLowerCase()}-history-refresh`);
					}
					modal.complete(result);
					new Notice(`${name} completed.`);
				} catch (error) {
					const detail = describeOperationError(error, `${name} failed.`);
					this.recordActivity(`${name} failed: ${detail}`, "ERROR");
					this.recordActivity(`${name} failed after ${formatMilliseconds(elapsedMilliseconds(startedAt))}.`, "METRIC");
					if (name === "Pull" || name === "Force Pull" || name === "Clone") this.markChangesRefreshRequiredViews(name);
					modal.fail(detail);
					new Notice(`${name} failed: ${detail}`);
				}
			});
		this.remoteOperationQueue = next;
		return next;
	}

	async checkForUpdates(manual: boolean): Promise<void> {
		if (!this.updater) return;
		const result = await this.updater.checkForUpdate({
			currentVersion: this.manifest.version,
			currentCommit: GIT_COMMIT_HASH,
			currentBranch: GIT_BRANCH,
			channel: this.settings.updateChannel,
		});
		this.settings.lastUpdateCheck = Date.now();
		await this.persistData();

		if (result.kind === "available") {
			this.recordActivity(`Update available: ${result.release.tag_name}.`);
			if (this.settings.autoUpdate && !result.release.prerelease) {
				try {
					const tempDir = await this.updater.downloadAndValidate(result.release);
					await this.updater.installUpdate(tempDir);
					this.recordActivity(`Installed stable update ${result.release.tag_name}.`);
					new Notice("Stable update installed. Reload Obsidian to apply it.");
				} catch (error) {
					const message = error instanceof Error ? error.message : "Unable to install the update.";
					this.recordActivity(`Automatic update failed: ${message}`, "ERROR");
					if (manual) new Notice(`Update failed: ${message}`);
				}
				return;
			}
			new UpdateAvailableModal(this.app, result, async () => {
				const tempDir = await this.updater!.downloadAndValidate(result.release);
				await this.updater!.installUpdate(tempDir);
				this.recordActivity(`Installed update ${result.release.tag_name}.`);
			}).open();
			return;
		}

		if (result.kind === "up-to-date") {
			this.recordActivity("Update check: current build is up to date.");
			if (manual) new Notice(`Git Sync is up to date (${result.currentVersion}).`);
			return;
		}

		this.recordActivity(`Update check: ${result.message}`);
		if (manual) new Notice(result.message);
	}

	showAvailableBuilds(): void {
		if (!this.updater) return;
		new AvailableBuildsModal(this.app, this.updater, async (build) => {
			const tempDir = await this.updater!.downloadAndValidate(build.release);
			await this.updater!.installUpdate(tempDir);
			this.recordActivity(`Installed development build ${build.release.tag_name}.`);
		}).open();
	}

	refreshViews(reason = "view-refresh", refreshChanges = true): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GIT_SYNC)) {
			const view = leaf.view;
			if (view instanceof GitSyncView) {
				void view.refreshRepositoryState(reason, refreshChanges);
			}
		}
	}

	refreshRemoteHistoryViews(reason = "remote-history-refresh"): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GIT_SYNC)) {
			const view = leaf.view;
			if (view instanceof GitSyncView) void view.refreshRemoteHistory(reason);
		}
	}

	markChangesRefreshRequiredViews(reason: string): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GIT_SYNC)) {
			const view = leaf.view;
			if (view instanceof GitSyncView) view.markChangesRefreshRequired(reason);
		}
	}
}

class GitSyncView extends ItemView {
	private readonly plugin: GitSyncPlugin;
	private activeTab = "Changes";
	private repositoryState: RepositoryState | null = null;
	private changes: ChangedFile[] | null = null;
	private commits: LocalCommit[] | null = null;
	private remoteCommits: LocalCommit[] | null = null;
	private remoteHistoryAvailable = false;
	private commitsError: string | null = null;
	private remoteCommitsError: string | null = null;
	private commitSource: CommitSource = "local";
	private selectedCommitOid: string | null = null;
	private readonly selectedPaths = new Set<string>();
	private readonly selectionAnchors = new Map<ChangeSection, string>();
	private readonly commitChangesCache = new Map<string, CommitFileChange[]>();
	private readonly commitChangesLoading = new Set<string>();
	private readonly commitChangesErrors = new Map<string, string>();
	private readonly changeFilters = new Map<ChangeSection, Set<ChangeStatusFilter>>();
	private readonly changeSorts = new Map<ChangeSection, ChangeSort>();
	private readonly commitDepth = new Map<CommitSource, number>([
		["local", COMMIT_PAGE_SIZE],
		["remote", COMMIT_PAGE_SIZE],
	]);
	private readonly commitHasMore = new Map<CommitSource, boolean>();
	private commitHistoryRepositoryPath = "";
	private commitHistoryBranchName = "";
	private longPressState: LongPressSelectionState | null = null;
	private readonly collapsedSections = new Set<"staged" | "uncommitted">();
	private changesError: string | null = null;
	private changesRefreshRequired = false;
	private changesRefreshReason = "";
	private committing = false;
	private commitMessage = "";
	private changesContentEl: HTMLElement | null = null;
	private changesScrollTop = 0;
	private refreshGeneration = 0;
	private activityVisibleCount = ACTIVITY_PAGE_SIZE;
	private commitHistoryLoading = false;
	private lastRepositoryActivity = "";

	constructor(leaf: WorkspaceLeaf, plugin: GitSyncPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_GIT_SYNC;
	}

	getDisplayText(): string {
		return "Git Sync";
	}

	getIcon(): string {
		return "git-branch";
	}

	onOpen(): Promise<void> {
		this.render();
		void this.refreshRepositoryState("view-open");
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.cancelLongPressSelection();
		this.contentEl.empty();
		return Promise.resolve();
	}

	refreshActivity(): void {
		if (this.activeTab === "Log") this.render();
	}

	render(): void {
		this.cancelLongPressSelection();
		this.captureChangesScrollTop();
		const root = this.contentEl;
		root.empty();
		root.addClass("git-sync-sidebar");

		const topbar = root.createDiv({ cls: "git-sync-topbar" });
		const tabs = topbar.createDiv({ cls: "git-sync-tabs", attr: { role: "tablist" } });
		for (const tabName of ["Changes", "Commits", "Log"]) {
			const tab = tabs.createEl("button", {
				text: tabName,
				cls: tabName === this.activeTab ? "git-sync-tab is-active" : "git-sync-tab",
				attr: { type: "button", role: "tab", "aria-selected": String(tabName === this.activeTab) },
			});
			tab.addEventListener("click", () => {
				this.activeTab = tabName;
				this.render();
			});
		}

		const settingsButton = topbar.createEl("button", {
			cls: "git-sync-settings-button",
			attr: { type: "button", "aria-label": "Open Git Sync settings", title: "Open Settings" },
		});
		setIcon(settingsButton, "settings");
		settingsButton.addEventListener("click", () => this.openSettings());
		const repository = this.plugin.settings.repositoryPath.trim();
		this.renderRepositoryContext(root, repository);

		const content = root.createDiv({ cls: "git-sync-content" });
		this.changesContentEl = null;
		if (this.activeTab === "Log") {
			this.renderActivity(content);
			return;
		}

		if (!repository) {
			this.renderSettingsPrompt(content, "Set up your repository");
			return;
		}

		if (!this.repositoryState || this.repositoryState.kind === "checking") {
			content.createDiv({ cls: "git-sync-state-title", text: "Checking repository" });
			content.createEl("p", {
				text: "Reading local repository information…",
				cls: "git-sync-state-description",
			});
			return;
		}

		if (this.repositoryState.kind === "missing") {
			content.createDiv({ cls: "git-sync-state-title", text: "No Git repository found" });
			content.createEl("p", {
				text: `No .git directory was found at ${this.repositoryState.repositoryPath}.`,
				cls: "git-sync-state-description",
			});
			this.addRefreshButton(content);
			return;
		}

		if (this.repositoryState.kind === "error") {
			content.createDiv({ cls: "git-sync-state-title", text: "Could not read repository" });
			content.createEl("p", {
				text: this.repositoryState.message,
				cls: "git-sync-state-description",
			});
			this.addRefreshButton(content);
			return;
		}

		if (this.activeTab === "Changes") {
			this.changesContentEl = content;
			this.renderChanges(content);
			this.renderChangesActionBar(root);
			this.restoreChangesScrollTop(content);
			return;
		}

		if (this.activeTab === "Commits") {
			this.renderCommits(content);
			return;
		}

		content.createDiv({ cls: "git-sync-state-title", text: this.activeTab });
		content.createEl("p", { text: `Local repository ready on ${this.repositoryState.branch}.`, cls: "git-sync-state-description" });
		this.addRefreshButton(content);
	}

	private renderRepositoryContext(root: HTMLElement, repository: string): void {
		const context = root.querySelector<HTMLElement>(".git-sync-repository-context") ?? root.createDiv({ cls: "git-sync-repository-context" });
		context.empty();
		const branch = context.createDiv({ cls: "git-sync-branch-context" });
		const branchIcon = branch.createSpan({ cls: "git-sync-branch-icon" });
		setIcon(branchIcon, "git-branch");
		const branchName = this.repositoryState?.kind === "ready"
			? this.repositoryState.branch
			: this.plugin.settings.branchName.trim() || "No branch";
		branch.createSpan({ cls: "git-sync-branch-name", text: branchName });

		const refreshButton = branch.createEl("button", {
			cls: "git-sync-context-action",
			attr: { type: "button", "aria-label": "Refresh repository", title: "Refresh repository" },
		});
		setIcon(refreshButton, "refresh-cw");
		refreshButton.disabled = !repository;
		refreshButton.addEventListener("click", () => void this.refreshRepositoryState("manual-refresh"));

		const comparisonState = this.getComparisonState(repository);
		const comparison = context.createDiv({ cls: "git-sync-comparison-status" });
		const comparisonIcon = comparison.createSpan({ cls: "git-sync-comparison-icon" });
		comparisonIcon.setAttribute("data-comparison-state", comparisonState.kind);
		setIcon(comparisonIcon, comparisonState.icon);
		comparison.createDiv({
			cls: "git-sync-comparison-text",
			text: comparisonState.label,
		});
	}

	private getComparisonState(repository: string): {
		kind: "unconfigured" | "checking" | "unavailable" | "up-to-date" | "local-ahead" | "remote-ahead" | "diverged";
		icon: string;
		label: string;
	} {
		if (!repository) return { kind: "unconfigured", icon: "alert-circle", label: "Repository not configured" };
		if (this.repositoryState?.kind !== "ready" || !this.commits || this.remoteCommits === null) {
			return { kind: "checking", icon: "loader", label: "Checking repository comparison" };
		}
		if (!this.remoteHistoryAvailable) {
			return { kind: "unavailable", icon: "alert-circle", label: "Remote comparison unavailable" };
		}

		const localHead = this.commits[0]?.oid;
		const remoteHead = this.remoteCommits[0]?.oid;
		if ((!localHead && !remoteHead) || localHead === remoteHead) {
			return { kind: "up-to-date", icon: "check-circle", label: "Up to date" };
		}
		if (!localHead || !remoteHead) {
			return localHead
				? { kind: "local-ahead", icon: "arrow-up", label: "Local is ahead" }
				: { kind: "remote-ahead", icon: "arrow-down", label: "Remote is ahead" };
		}
		if (this.remoteCommits.some((commit) => commit.oid === localHead)) {
			return { kind: "remote-ahead", icon: "arrow-down", label: "Remote is ahead" };
		}
		if (this.commits.some((commit) => commit.oid === remoteHead)) {
			return { kind: "local-ahead", icon: "arrow-up", label: "Local is ahead" };
		}
		return { kind: "diverged", icon: "git-compare", label: "Branches have diverged" };
	}

	async refreshRepositoryState(reason = "refresh", refreshChanges = true): Promise<void> {
		const startedAt = Date.now();
		const phaseDurations: Array<{ label: string; elapsed: number }> = [];
		const timed = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
			const phaseStartedAt = Date.now();
			try {
				return await operation();
			} finally {
				phaseDurations.push({ label, elapsed: Date.now() - phaseStartedAt });
			}
		};
		const repositoryPath = this.plugin.settings.repositoryPath.trim();
		if (!repositoryPath) {
			this.repositoryState = null;
			this.render();
			this.plugin.recordActivity(`Repository refresh [${reason}] skipped: no repository path configured.`, "METRIC");
			return;
		}
		const branchName = this.plugin.settings.branchName.trim();
		if (this.commitHistoryRepositoryPath !== repositoryPath) {
			this.commitDepth.set("local", COMMIT_PAGE_SIZE);
			this.commitDepth.set("remote", COMMIT_PAGE_SIZE);
			this.commitHasMore.clear();
			this.commitHistoryRepositoryPath = repositoryPath;
		}
		if (this.commitHistoryBranchName !== branchName) {
			this.commitDepth.set("remote", COMMIT_PAGE_SIZE);
			this.commitHasMore.delete("remote");
			this.commitHistoryBranchName = branchName;
		}

		const generation = ++this.refreshGeneration;
		this.changesRefreshRequired = !refreshChanges;
		this.changesRefreshReason = refreshChanges ? "" : reason;
		if (!refreshChanges) {
			this.changes = null;
			this.changesError = null;
			this.selectedPaths.clear();
		}
		this.repositoryState = { kind: "checking", repositoryPath };
		if (this.activeTab === "Changes" && this.changesContentEl?.isConnected) {
			this.renderRepositoryContext(this.contentEl, repositoryPath);
		} else {
			this.render();
		}
		const state = await timed("inspect", () => inspectLocalRepository(this.app.vault.adapter, repositoryPath));
		if (generation !== this.refreshGeneration || !this.contentEl.isConnected) return;
		this.repositoryState = state;
		if (state.kind === "ready") {
			if (refreshChanges) {
				this.changesRefreshRequired = false;
				this.changesRefreshReason = "";
				try {
					this.changes = await timed("changes", () => readChanges(this.app.vault.adapter, repositoryPath));
					const availablePaths = new Set(this.changes.map((change) => change.path));
					for (const selectedPath of this.selectedPaths) {
						if (!availablePaths.has(selectedPath)) this.selectedPaths.delete(selectedPath);
					}
					this.changesError = null;
				} catch (error) {
					this.changes = null;
					this.changesError = error instanceof Error ? error.message : "Unable to read local changes.";
				}
			}
			try {
				const localCommitHistory = await timed(
					"commits",
					() => readCommits(this.app.vault.adapter, repositoryPath, this.commitDepth.get("local") ?? COMMIT_PAGE_SIZE),
				);
				this.commits = this.hydrateCommitChanges(
					localCommitHistory.commits,
					repositoryPath,
				);
				this.commitHasMore.set("local", localCommitHistory.hasMore);
				this.commitsError = null;
				if (this.selectedCommitOid && !this.commits.some((commit) => commit.oid === this.selectedCommitOid)) {
					this.selectedCommitOid = null;
				}
			} catch (error) {
				this.commits = null;
				this.commitHasMore.set("local", false);
				this.commitsError = error instanceof Error ? error.message : "Unable to read local commits.";
			}
			try {
				const remoteCommitHistory = await timed("remote-commits", () => readRemoteCommits(
					this.app.vault.adapter,
					repositoryPath,
					this.plugin.settings.branchName,
					this.commitDepth.get("remote") ?? COMMIT_PAGE_SIZE,
				));
				this.remoteCommits = this.hydrateCommitChanges(remoteCommitHistory.commits, repositoryPath);
				this.remoteHistoryAvailable = remoteCommitHistory.available;
				this.commitHasMore.set("remote", remoteCommitHistory.hasMore);
				this.remoteCommitsError = null;
			} catch (error) {
				this.remoteCommits = null;
				this.remoteHistoryAvailable = false;
				this.commitHasMore.set("remote", false);
				this.remoteCommitsError = error instanceof Error ? error.message : "Unable to read remote commits.";
			}
		} else {
			this.changes = null;
			this.changesError = null;
			this.commits = null;
			this.remoteCommits = null;
			this.remoteHistoryAvailable = false;
			this.commitsError = null;
			this.remoteCommitsError = null;
			this.selectedCommitOid = null;
		}
		if (generation !== this.refreshGeneration || !this.contentEl.isConnected) return;
		const phases = phaseDurations.map(({ label, elapsed }) => `${label} ${formatMilliseconds(elapsed)}`).join(", ");
		const changeCount = this.changes?.length ?? 0;
		const localCommitCount = this.commits?.length ?? 0;
		const remoteCommitCount = this.remoteCommits?.length ?? 0;
		const refreshLabel = refreshChanges ? "Repository refresh" : "Repository metadata refresh";
		const changeSummary = refreshChanges ? `${changeCount} changes` : "Changes scan deferred";
		this.plugin.recordActivity(
			`${refreshLabel} [${reason}] completed in ${formatMilliseconds(elapsedMilliseconds(startedAt))} (${phases}; ${changeSummary}, ${localCommitCount} local commits, ${remoteCommitCount} remote commits).`,
			"METRIC",
		);
		this.recordRepositoryActivity(state);
		if (this.activeTab === "Changes" && this.changesContentEl?.isConnected) {
			this.renderRepositoryContext(this.contentEl, repositoryPath);
			this.updateChangesContent();
		} else {
			this.render();
		}
	}

	private renderChanges(content: HTMLElement): void {
		if (this.changesRefreshRequired) {
			const notice = content.createDiv({ cls: "git-sync-refresh-required" });
			notice.createDiv({ cls: "git-sync-state-title", text: "Changes need refreshing" });
			notice.createEl("p", {
				text: `The working tree may have changed after ${this.changesRefreshReason}. Refresh the repository to read the current Changes list.`,
				cls: "git-sync-state-description",
			});
			const refresh = notice.createEl("button", { text: "Refresh repository", attr: { type: "button" } });
			refresh.addEventListener("click", () => void this.refreshRepositoryState("manual-refresh"));
			return;
		}
		if (this.changesError) {
			content.createEl("p", { text: this.changesError, cls: "git-sync-state-description" });
			return;
		}
		if (!this.changes) {
			content.createEl("p", { text: "Reading local changes…", cls: "git-sync-state-description" });
			return;
		}
		const staged = this.changes.filter((change) => change.staged);
		const uncommitted = this.changes.filter((change) => !change.staged);
		this.renderChangeSection(content, "staged", "STAGED", staged, "Unstage selected");
		this.renderChangeSection(content, "uncommitted", "UNCOMMITTED CHANGES", uncommitted, "Stage selected");

		const stagedCount = staged.length;
		const commit = content.createDiv({ cls: "git-sync-commit" });
		commit.createDiv({ text: "Commit staged changes", cls: "git-sync-commit-title" });
		commit.createDiv({ text: `${stagedCount} file${stagedCount === 1 ? "" : "s"} staged`, cls: "git-sync-commit-meta" });
		const message = commit.createEl("textarea", {
			attr: { placeholder: "Commit message", "aria-label": "Commit message", rows: "3" },
		});
		message.value = this.commitMessage;
		message.addEventListener("input", () => {
			this.commitMessage = message.value;
		});
		const commitActions = commit.createDiv({ cls: "git-sync-commit-actions" });
		const commitButton = commitActions.createEl("button", { text: "Commit", cls: "mod-cta", attr: { type: "button" } });
		commitButton.disabled = stagedCount === 0 || this.committing;
		commitButton.addEventListener("click", () => void this.commit(message.value));
	}

	private renderCommits(content: HTMLElement): void {
		const commits = this.commitSource === "local" ? this.commits : this.remoteCommits;
		const sourceLabel = this.commitSource === "local" ? "local" : "remote";
		const header = content.createDiv({ cls: "git-sync-commits-header" });
		header.createDiv({ cls: "git-sync-state-title", text: "Commits" });
		header.createDiv({
			cls: "git-sync-commits-count",
			text: commits ? `${commits.length} ${sourceLabel} commit${commits.length === 1 ? "" : "s"}` : `${sourceLabel} history`,
		});

		const sourceToggle = content.createDiv({ cls: "git-sync-source-toggle", attr: { role: "tablist" } });
		for (const source of ["local", "remote"] as const) {
			const button = sourceToggle.createEl("button", {
				text: source === "local" ? "Local" : "Remote",
				cls: source === this.commitSource ? "is-active" : "",
				attr: {
					type: "button",
					role: "tab",
					"aria-selected": String(source === this.commitSource),
				},
			});
			button.addEventListener("click", () => {
				this.commitSource = source;
				this.selectedCommitOid = null;
				this.render();
			});
		}

		if (this.commitSource === "remote" && this.remoteCommitsError) {
			content.createEl("p", { text: this.remoteCommitsError, cls: "git-sync-state-description" });
			this.addRefreshButton(content);
			return;
		}
		if (this.commitSource === "remote" && !this.remoteCommits) {
			content.createEl("p", { text: "Reading remote commit history…", cls: "git-sync-state-description" });
			return;
		}
		if (this.commitSource === "remote" && !this.remoteHistoryAvailable) {
			const unavailable = content.createDiv({ cls: "git-sync-history-unavailable" });
			const icon = unavailable.createSpan({ cls: "git-sync-history-unavailable-icon" });
			setIcon(icon, "cloud-off");
			unavailable.createDiv({ cls: "git-sync-state-title", text: "No fetched remote history" });
			unavailable.createEl("p", {
				text: `Fetch origin/${this.plugin.settings.branchName} to load the remote commit history here.`,
				cls: "git-sync-state-description",
			});
			return;
		}

		if (this.commitsError) {
			content.createEl("p", { text: this.commitsError, cls: "git-sync-state-description" });
			this.addRefreshButton(content);
			return;
		}
		if (!this.commits) {
			content.createEl("p", { text: "Reading local commit history…", cls: "git-sync-state-description" });
			return;
		}
		if (commits!.length === 0) {
			content.createDiv({
				cls: "git-sync-history-empty",
				text: this.commitSource === "local" ? "No local commits yet." : "No commits on the fetched remote branch.",
			});
			return;
		}

		this.renderCommitList(content, commits!, this.commitSource === "local" ? "LOCAL" : "ORIGIN");
		if (this.commitHasMore.get(this.commitSource)) {
			const loadMore = content.createEl("button", {
				text: this.commitHistoryLoading ? "Loading commits…" : "Load more commits",
				cls: "git-sync-load-more",
				attr: { type: "button" },
			});
			loadMore.disabled = this.commitHistoryLoading;
			loadMore.addEventListener("click", () => void this.loadMoreCommits());
		}
	}

	private renderCommitList(content: HTMLElement, commits: LocalCommit[], badge: "LOCAL" | "ORIGIN"): void {
		const list = content.createEl("ol", { cls: "git-sync-commit-list" });
		for (const commit of commits) {
			const item = list.createEl("li", { cls: "git-sync-commit-item" });
			const selected = this.selectedCommitOid === commit.oid;
			const button = item.createEl("button", {
				cls: selected ? "git-sync-commit-row is-selected" : "git-sync-commit-row",
				attr: {
					type: "button",
					"aria-expanded": String(selected),
					"aria-label": `${selected ? "Hide" : "Show"} details for ${commitTitle(commit.message)}`,
				},
			});
			const marker = button.createSpan({ cls: "git-sync-commit-marker" });
			marker.setAttribute("aria-hidden", "true");
			const summary = button.createDiv({ cls: "git-sync-commit-summary" });
			const title = summary.createDiv({ cls: "git-sync-commit-message", text: commitTitle(commit.message) });
			title.setAttribute("title", commit.message);
			const meta = summary.createDiv({ cls: "git-sync-commit-meta" });
			meta.createSpan({ cls: "git-sync-commit-oid", text: commit.oid.slice(0, 7) });
			meta.createSpan({ text: commit.author.name || "Unknown author" });
			meta.createSpan({ cls: badge === "ORIGIN" ? "git-sync-commit-origin-badge" : "git-sync-commit-local-badge", text: badge });
			const time = button.createSpan({ cls: "git-sync-commit-time", text: formatRelativeCommitTime(commit.author.timestamp) });
			time.setAttribute("title", formatCommitTimestamp(commit.author.timestamp));
			const chevron = button.createSpan({ cls: "git-sync-commit-chevron" });
			setIcon(chevron, selected ? "chevron-down" : "chevron-right");
			button.addEventListener("click", () => {
				this.selectedCommitOid = selected ? null : commit.oid;
				this.render();
			});

			if (selected) this.renderCommitDetails(item, commit);
		}
	}

	private async loadMoreCommits(): Promise<void> {
		if (this.commitHistoryLoading || !this.commitHasMore.get(this.commitSource)) return;
		const source = this.commitSource;
		const repositoryPath = this.plugin.settings.repositoryPath.trim();
		const previousDepth = this.commitDepth.get(source) ?? COMMIT_PAGE_SIZE;
		const nextDepth = previousDepth + COMMIT_PAGE_SIZE;
		this.commitDepth.set(source, nextDepth);
		this.commitHistoryLoading = true;
		this.render();
		const startedAt = Date.now();

		try {
			if (source === "local") {
				const history = await readCommits(this.app.vault.adapter, repositoryPath, nextDepth);
				this.commits = this.hydrateCommitChanges(history.commits, repositoryPath);
				this.commitHasMore.set(source, history.hasMore);
				this.commitsError = null;
			} else {
				const history = await readRemoteCommits(
					this.app.vault.adapter,
					repositoryPath,
					this.plugin.settings.branchName,
					nextDepth,
				);
				this.remoteCommits = this.hydrateCommitChanges(history.commits, repositoryPath);
				this.remoteHistoryAvailable = history.available;
				this.commitHasMore.set(source, history.hasMore);
				this.remoteCommitsError = null;
			}
			this.plugin.recordActivity(
				`Loaded ${source} commits through ${nextDepth} entries in ${formatMilliseconds(elapsedMilliseconds(startedAt))}.`,
				"METRIC",
			);
		} catch (error) {
			this.commitDepth.set(source, previousDepth);
			if (source === "local") {
				this.commitsError = error instanceof Error ? error.message : "Unable to load more local commits.";
			} else {
				this.remoteCommitsError = error instanceof Error ? error.message : "Unable to load more remote commits.";
			}
		} finally {
			this.commitHistoryLoading = false;
			this.render();
		}
	}

	private renderCommitDetails(item: HTMLElement, commit: LocalCommit): void {
		const details = item.createDiv({ cls: "git-sync-commit-details" });
		details.createDiv({ cls: "git-sync-commit-detail-message", text: commit.message.trim() });
		const author = details.createDiv({ cls: "git-sync-commit-detail-meta" });
		author.createSpan({ text: `${commit.author.name || "Unknown author"} <${commit.author.email}>` });
		author.createSpan({ text: formatCommitTimestamp(commit.author.timestamp) });
		details.createDiv({ cls: "git-sync-commit-detail-hash", text: commit.oid });

		const cacheKey = this.commitChangesCacheKey(commit.oid);
		const loadingError = this.commitChangesErrors.get(cacheKey);
		if (!commit.changesLoaded) {
			details.createDiv({ cls: "git-sync-commit-files-title", text: "Changed files" });
			details.createDiv({
				cls: loadingError ? "git-sync-commit-files-error" : "git-sync-commit-files-loading",
				text: loadingError ? `Unable to load changed files: ${loadingError}` : "Loading changed files…",
			});
			void this.loadCommitChanges(commit.oid);
			return;
		}

		const filesTitle = details.createDiv({ cls: "git-sync-commit-files-title", text: `Changed files (${commit.changes.length})` });
		if (commit.changes.length === 0) {
			details.createDiv({ cls: "git-sync-commit-files-empty", text: "No changed files recorded." });
			return;
		}
		const files = details.createEl("ul", { cls: "git-sync-commit-files" });
		for (const file of commit.changes) {
			const row = files.createEl("li");
			const status = row.createSpan({ cls: "git-sync-commit-file-status", text: commitFileCode(file.status) });
			status.setAttribute("data-commit-file-status", file.status);
			row.createSpan({ cls: "git-sync-commit-file-path", text: file.path });
		}
		filesTitle.setAttribute("aria-hidden", "true");
	}

	private hydrateCommitChanges(commits: LocalCommit[], repositoryPath: string): LocalCommit[] {
		return commits.map((commit) => {
			const changes = this.commitChangesCache.get(this.commitChangesCacheKey(commit.oid, repositoryPath));
			return changes
				? { ...commit, changes, changesLoaded: true }
				: commit;
		});
	}

	private async loadCommitChanges(commitOid: string): Promise<void> {
		const repositoryPath = this.plugin.settings.repositoryPath.trim();
		const cacheKey = this.commitChangesCacheKey(commitOid, repositoryPath);
		if (this.commitChangesLoading.has(cacheKey)) return;
		const cached = this.commitChangesCache.get(cacheKey);
		if (cached) {
			this.applyLoadedCommitChanges(commitOid, cached);
			return;
		}

		this.commitChangesLoading.add(cacheKey);
		this.commitChangesErrors.delete(cacheKey);
		const startedAt = Date.now();
		try {
			const changes = await readCommitChanges(this.app.vault.adapter, repositoryPath, commitOid);
			this.commitChangesCache.set(cacheKey, changes);
			this.applyLoadedCommitChanges(commitOid, changes);
			this.plugin.recordActivity(
				`Commit ${commitOid.slice(0, 7)} changed-file details loaded in ${formatMilliseconds(elapsedMilliseconds(startedAt))} (${changes.length} files).`,
				"METRIC",
			);
		} catch (error) {
			const detail = error instanceof Error ? error.message : "Unable to read changed files.";
			this.commitChangesErrors.set(
				cacheKey,
				detail,
			);
			this.plugin.recordActivity(
				`Commit ${commitOid.slice(0, 7)} changed-file details failed after ${formatMilliseconds(elapsedMilliseconds(startedAt))}: ${detail}`,
				"ERROR",
			);
		} finally {
			this.commitChangesLoading.delete(cacheKey);
			if (this.selectedCommitOid === commitOid) this.render();
		}
	}

	private applyLoadedCommitChanges(commitOid: string, changes: CommitFileChange[]): void {
		const update = (commits: LocalCommit[] | null): LocalCommit[] | null => commits?.map((commit) =>
			commit.oid === commitOid ? { ...commit, changes, changesLoaded: true } : commit,
		) ?? null;
		this.commits = update(this.commits);
		this.remoteCommits = update(this.remoteCommits);
	}

	private commitChangesCacheKey(commitOid: string, repositoryPath = this.plugin.settings.repositoryPath.trim()): string {
		return `${repositoryPath}\u0000${commitOid}`;
	}

	private renderChangeSection(
		content: HTMLElement,
		section: ChangeSection,
		title: string,
		changes: ChangedFile[],
		bulkAction: string,
	): void {
		const sectionEl = content.createDiv({ cls: "git-sync-change-section" });
		const header = sectionEl.createDiv({ cls: "git-sync-change-section-header" });
		header.createDiv({ cls: "git-sync-section-title", text: title });
		header.createDiv({ cls: "git-sync-section-count", text: String(changes.length) });
		const filter = header.createEl("button", {
			cls: "git-sync-section-action",
			attr: {
				type: "button",
				"aria-label": `Filter ${title.toLowerCase()}`,
				title: "Filter by status",
				"data-active": String(this.hasChangeFilter(section)),
			},
		});
		setIcon(filter, "filter");
		filter.addEventListener("click", (event) => this.showChangeFilterMenu(section, event));
		const sort = header.createEl("button", {
			cls: "git-sync-section-action",
			attr: {
				type: "button",
				"aria-label": `Sort ${title.toLowerCase()}`,
				title: `Sort: ${this.getChangeSortLabel(section)}`,
			},
		});
		setIcon(sort, "arrow-down-up");
		sort.addEventListener("click", (event) => this.showChangeSortMenu(section, event));
		const sectionAction = header.createEl("button", {
			cls: "git-sync-section-action",
			attr: {
				type: "button",
				"aria-label": section === "staged" ? "Unstage all staged files" : "Stage all uncommitted files",
				title: section === "staged" ? "Unstage all" : "Stage all",
			},
		});
		setIcon(sectionAction, section === "staged" ? "minus" : "plus");
		sectionAction.disabled = changes.length === 0 || this.committing;
		sectionAction.addEventListener("click", () => void this.applyAllStage(section === "staged"));
		const collapse = header.createEl("button", {
			cls: "git-sync-icon-button",
			attr: { type: "button", "aria-label": `${this.collapsedSections.has(section) ? "Expand" : "Collapse"} ${title}` },
		});
		setIcon(collapse, this.collapsedSections.has(section) ? "chevron-right" : "chevron-down");
		collapse.addEventListener("click", () => {
			if (this.collapsedSections.has(section)) this.collapsedSections.delete(section);
			else this.collapsedSections.add(section);
			this.render();
		});

		if (this.collapsedSections.has(section)) return;
		const visibleChanges = this.getVisibleChanges(section, changes);

		if (changes.length === 0) {
			sectionEl.createDiv({ cls: "git-sync-section-empty", text: section === "staged" ? "No staged files" : "No uncommitted changes" });
			return;
		}

		if (visibleChanges.length === 0) {
			sectionEl.createDiv({ cls: "git-sync-section-empty", text: "No files match this filter" });
			return;
		}

		const selectedInSection = changes.filter((change) => this.selectedPaths.has(change.path));
		if (selectedInSection.length > 1) {
			const toolbar = sectionEl.createDiv({ cls: "git-sync-change-toolbar" });
			toolbar.createDiv({ cls: "git-sync-select-label", text: `${selectedInSection.length} selected` });
			const clear = toolbar.createEl("button", {
				cls: "git-sync-selection-action",
				attr: { type: "button", "aria-label": "Clear selection", title: "Clear selection" },
			});
			setIcon(clear, "x");
			clear.addEventListener("click", () => {
				for (const change of changes) this.selectedPaths.delete(change.path);
				this.render();
			});
			const action = toolbar.createEl("button", {
				cls: "git-sync-selection-action",
				attr: {
					type: "button",
					"aria-label": bulkAction === "Stage selected" ? "Stage selected files" : "Unstage selected files",
					title: bulkAction === "Stage selected" ? "Stage selected files" : "Unstage selected files",
				},
			});
			setIcon(action, section === "staged" ? "arrow-down-to-line" : "arrow-up-to-line");
			action.disabled = this.committing;
			action.addEventListener("click", () => void this.applySelectedStage(section === "staged"));
		}

		const list = sectionEl.createEl("ul", { cls: "git-sync-changes-list" });
		for (const [index, change] of visibleChanges.entries()) {
			this.renderChangeRow(list, change, section, index, visibleChanges);
		}
	}

	private renderChangeRow(
		list: HTMLElement,
		change: ChangedFile,
		section: ChangeSection,
		index: number,
		visibleChanges: ChangedFile[],
	): void {
		const item = list.createEl("li", {
			cls: this.selectedPaths.has(change.path) ? "git-sync-change is-selected" : "git-sync-change",
			attr: { "data-change-path": change.path, "data-change-section": section },
		});
		const checkbox = item.createEl("input", {
			attr: { type: "checkbox", "aria-label": `Select ${change.path}`, "data-change-path": change.path },
		});
		checkbox.checked = this.selectedPaths.has(change.path);
		checkbox.disabled = this.committing;
		checkbox.addEventListener("click", (event) => {
			event.preventDefault();
			this.handleSelectionClick(section, change.path, event, visibleChanges);
		});

		const code = item.createSpan({ cls: "git-sync-change-code", text: changeCode(change.status) });
		code.setAttribute("data-change-status", change.status);
		const directAction = item.createEl("button", {
			cls: "git-sync-change-direct-action",
			attr: {
				type: "button",
				"aria-label": `${change.staged ? "Unstage" : "Stage"} ${change.path}`,
				title: change.staged ? "Unstage" : "Stage",
				"data-change-path": change.path,
			},
		});
		setIcon(directAction, change.staged ? "minus" : "plus");
		directAction.disabled = this.committing;
		directAction.addEventListener("click", () => void this.toggleStage(change));
		const path = item.createDiv({ cls: "git-sync-change-path", text: change.path });
		path.setAttribute("title", change.path);
		const menuButton = item.createEl("button", {
			cls: "git-sync-change-menu",
			attr: {
				type: "button",
				"aria-label": `More actions for ${change.path}`,
				title: "More actions",
				"data-change-path": change.path,
			},
		});
		setIcon(menuButton, "more-horizontal");
		menuButton.disabled = this.committing;
		menuButton.addEventListener("click", (event) => this.showChangeMenu(change, event));
		this.bindLongPressSelection(item, section, change.path, visibleChanges, index);
	}

	private getVisibleChanges(section: ChangeSection, changes: ChangedFile[]): ChangedFile[] {
		const filters = this.changeFilters.get(section);
		const filtered = filters && filters.size > 0
			? changes.filter((change) => filters.has(changeFilterKey(change.status)))
			: [...changes];
		const sort = this.changeSorts.get(section) ?? "path-asc";
		return filtered.sort((left, right) => compareChanges(left, right, sort));
	}

	private hasChangeFilter(section: ChangeSection): boolean {
		const filters = this.changeFilters.get(section);
		return Boolean(filters && filters.size < CHANGE_STATUS_FILTERS.length);
	}

	private getChangeSortLabel(section: ChangeSection): string {
		return CHANGE_SORTS.find((sort) => sort.value === (this.changeSorts.get(section) ?? "path-asc"))?.label ?? "Path (A–Z)";
	}

	private showChangeFilterMenu(section: ChangeSection, event: MouseEvent): void {
		const menu = new Menu();
		const filters = this.changeFilters.get(section);
		menu.addItem((item) => item
			.setTitle("All status types")
			.setIcon("list")
			.setChecked(!filters || filters.size === 0)
			.onClick(() => {
				this.changeFilters.delete(section);
				this.render();
			}));
		for (const status of CHANGE_STATUS_FILTERS) {
			menu.addItem((item) => item
				.setTitle(`${changeCode(status)} ${status}`)
				.setChecked(!filters || filters.size === 0 || filters.has(status))
				.onClick(() => this.toggleChangeFilter(section, status)));
		}
		menu.showAtMouseEvent(event);
	}

	private toggleChangeFilter(section: ChangeSection, status: ChangeStatusFilter): void {
		const current = new Set(this.changeFilters.get(section) ?? CHANGE_STATUS_FILTERS);
		if (current.has(status)) current.delete(status);
		else current.add(status);
		if (current.size === 0 || current.size === CHANGE_STATUS_FILTERS.length) this.changeFilters.delete(section);
		else this.changeFilters.set(section, current);
		this.render();
	}

	private showChangeSortMenu(section: ChangeSection, event: MouseEvent): void {
		const current = this.changeSorts.get(section) ?? "path-asc";
		const menu = new Menu();
		for (const sort of CHANGE_SORTS) {
			menu.addItem((item) => item
				.setTitle(sort.label)
				.setChecked(current === sort.value)
				.onClick(() => {
					this.changeSorts.set(section, sort.value);
					this.render();
				}));
		}
		menu.showAtMouseEvent(event);
	}

	private handleSelectionClick(
		section: ChangeSection,
		path: string,
		event: MouseEvent,
		visibleChanges: ChangedFile[],
	): void {
		if (event.shiftKey) {
			const anchor = this.selectionAnchors.get(section);
			if (anchor) this.selectChangeRange(section, anchor, path, visibleChanges);
			else this.selectedPaths.add(path);
		} else {
			if (event.metaKey || event.ctrlKey) {
				if (this.selectedPaths.has(path)) this.selectedPaths.delete(path);
				else this.selectedPaths.add(path);
			} else if (this.selectedPaths.has(path)) {
				this.selectedPaths.delete(path);
			} else {
				this.selectedPaths.add(path);
			}
			this.selectionAnchors.set(section, path);
		}
		this.render();
	}

	private selectChangeRange(section: ChangeSection, anchor: string, target: string, changes: ChangedFile[]): void {
		const anchorIndex = changes.findIndex((change) => change.path === anchor);
		const targetIndex = changes.findIndex((change) => change.path === target);
		if (anchorIndex === -1 || targetIndex === -1) {
			this.selectedPaths.add(target);
			return;
		}
		const start = Math.min(anchorIndex, targetIndex);
		const end = Math.max(anchorIndex, targetIndex);
		for (const change of changes.slice(start, end + 1)) this.selectedPaths.add(change.path);
	}

	private bindLongPressSelection(
		item: HTMLElement,
		section: ChangeSection,
		path: string,
		visibleChanges: ChangedFile[],
		_index: number,
	): void {
		item.addEventListener("pointerdown", (event) => {
			if (event.pointerType === "mouse" || (event.target instanceof HTMLElement && event.target.closest("button, input"))) return;
			this.cancelLongPressSelection();
			item.setPointerCapture?.(event.pointerId);
			const state: LongPressSelectionState = {
				section,
				path,
				visibleChanges,
				pointerId: event.pointerId,
				startX: event.clientX,
				startY: event.clientY,
				timer: 0,
				active: false,
				suppressClick: false,
			};
			state.timer = window.setTimeout(() => {
				if (this.longPressState !== state) return;
				state.active = true;
				state.suppressClick = true;
				this.selectionAnchors.set(section, path);
				this.selectedPaths.add(path);
				item.addClass("is-selected");
			}, 450);
			this.longPressState = state;
		});

		item.addEventListener("pointermove", (event) => {
			const state = this.longPressState;
			if (!state || state.pointerId !== event.pointerId) return;
			if (!state.active) {
				const moved = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
				if (moved > 10) this.cancelLongPressSelection();
				return;
			}
			event.preventDefault();
			const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".git-sync-change");
			if (!target || target.dataset.changeSection !== section) return;
			const targetPath = target.dataset.changePath;
			if (!targetPath) return;
			this.selectChangeRange(section, path, targetPath, visibleChanges);
			this.updateRenderedSelectionState(section);
		});

		const finish = (event: PointerEvent) => {
			const state = this.longPressState;
			if (!state || state.pointerId !== event.pointerId) return;
			window.clearTimeout(state.timer);
			item.releasePointerCapture?.(event.pointerId);
			this.longPressState = null;
			if (state.active) {
				this.updateRenderedSelectionState(section);
				this.render();
			}
		};
		item.addEventListener("pointerup", finish);
		item.addEventListener("pointercancel", finish);
		item.addEventListener("contextmenu", (event) => {
			if (this.longPressState?.active) event.preventDefault();
		});
	}

	private updateRenderedSelectionState(section: ChangeSection): void {
		for (const row of this.contentEl.querySelectorAll<HTMLElement>(`.git-sync-change[data-change-section="${section}"]`)) {
			const path = row.dataset.changePath;
			const selected = Boolean(path && this.selectedPaths.has(path));
			row.classList.toggle("is-selected", selected);
			const checkbox = row.querySelector<HTMLInputElement>("input[type=checkbox]");
			if (checkbox) checkbox.checked = selected;
		}
	}

	private cancelLongPressSelection(): void {
		if (this.longPressState) window.clearTimeout(this.longPressState.timer);
		this.longPressState = null;
	}

	private showChangeMenu(change: ChangedFile, event: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) => item.setTitle("Open file").setIcon("file").onClick(() => this.openChangedFile(change.path)));
		menu.addItem((item) => item.setTitle("Copy path").setIcon("copy").onClick(() => void this.copyChangedPath(change.path)));
		menu.addSeparator();
		menu.addItem((item) => item
			.setTitle(change.staged ? "Unstage" : "Stage")
			.setIcon(change.staged ? "minus" : "plus")
			.onClick(() => void this.toggleStage(change)));
		menu.addItem((item) => item.setTitle("Add to gitignore").setIcon("file-minus").onClick(() => void this.ignoreChangedFile(change.path)));
		menu.addItem((item) => item
			.setTitle("Delete (git rm)")
			.setIcon("trash-2")
			.setWarning(true)
			.setDisabled(change.status === "Untracked")
			.onClick(() => this.confirmRemoveChangedFile(change)));
		menu.showAtMouseEvent(event);
	}

	private openChangedFile(path: string): void {
		this.app.workspace.openLinkText(this.vaultPathForChange(path), "", false);
	}

	private async copyChangedPath(path: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(this.vaultPathForChange(path));
			new Notice("Path copied.");
		} catch {
			new Notice("Unable to copy the path.");
		}
	}

	private async ignoreChangedFile(path: string): Promise<void> {
		try {
			await addToGitignore(this.app.vault.adapter, this.plugin.settings.repositoryPath, path);
			this.plugin.recordActivity(`Added ${path} to .gitignore.`);
			new Notice("Added to .gitignore.");
			await this.refreshChangesForPaths([path, ".gitignore"], [".gitignore"], "gitignore-refresh");
		} catch (error) {
			const detail = error instanceof Error ? error.message : "Unable to update .gitignore.";
			this.plugin.recordActivity(`Could not update .gitignore: ${detail}`, "ERROR");
			new Notice(detail);
		}
	}

	private confirmRemoveChangedFile(change: ChangedFile): void {
		new ConfirmActionModal(
			this.app,
			"Delete changed file?",
			`This runs git rm for ${change.path} and stages the deletion.`,
			() => void this.removeChangedFile(change),
		).open();
	}

	private async removeChangedFile(change: ChangedFile): Promise<void> {
		try {
			await removeFile(this.app.vault.adapter, this.plugin.settings.repositoryPath, change.path);
			this.selectedPaths.delete(change.path);
			this.plugin.recordActivity(`Removed ${change.path} with git rm.`);
			new Notice("File removed with git rm.");
			this.applyKnownChangeUpdates([change.path], [{ path: change.path, status: "Deleted", staged: true }]);
		} catch (error) {
			const detail = error instanceof Error ? error.message : "Unable to remove the file with git rm.";
			this.plugin.recordActivity(`Could not remove ${change.path}: ${detail}`, "ERROR");
			new Notice(detail);
		}
	}

	private vaultPathForChange(path: string): string {
		const repository = this.plugin.settings.repositoryPath.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
		return repository && repository !== "." ? `${repository}/${path}` : path;
	}

	private renderChangesActionBar(root: HTMLElement): HTMLElement {
		const bar = root.createDiv({ cls: "git-sync-bottom-bar" });
		const selectAll = bar.createEl("button", {
			cls: "git-sync-bottom-action is-primary",
			attr: { type: "button", "aria-label": "Select all changed files", title: "Select all" },
		});
		setIcon(selectAll, "check-square");
		selectAll.addEventListener("click", () => {
			this.selectAllChanges();
			this.render();
		});

		const pull = bar.createEl("button", {
			cls: "git-sync-bottom-action",
			attr: { type: "button", "aria-label": "Pull from remote", title: "Pull from remote" },
		});
		setIcon(pull, "arrow-down-to-line");
		pull.addEventListener("click", () => void this.plugin.pullRemote());

		const forcePull = bar.createEl("button", {
			cls: "git-sync-bottom-action is-destructive",
			attr: { type: "button", "aria-label": "Reset local branch to remote", title: "Reset local branch to remote" },
		});
		setIcon(forcePull, "arrow-down-to-line");
		forcePull.addEventListener("click", () => this.plugin.forcePullRemote());

		const push = bar.createEl("button", {
			cls: "git-sync-bottom-action",
			attr: { type: "button", "aria-label": "Push to remote", title: "Push to remote" },
		});
		setIcon(push, "arrow-up-to-line");
		push.addEventListener("click", () => void this.plugin.pushRemote());

		const forcePush = bar.createEl("button", {
			cls: "git-sync-bottom-action is-destructive",
			attr: { type: "button", "aria-label": "Force push to remote", title: "Force push to remote" },
		});
		setIcon(forcePush, "arrow-up-to-line");
		forcePush.addEventListener("click", () => this.plugin.forcePushRemote());

		const refresh = bar.createEl("button", {
			cls: "git-sync-bottom-action",
			attr: { type: "button", "aria-label": "Fetch from remote", title: "Fetch from remote" },
		});
		setIcon(refresh, "refresh-cw");
		refresh.addEventListener("click", () => void this.plugin.fetchRemote());
		return bar;
	}

	private selectAllChanges(): void {
		for (const change of this.changes ?? []) this.selectedPaths.add(change.path);
	}

	private async applyAllStage(unstage: boolean): Promise<void> {
		const changes = (this.changes ?? []).filter((change) => change.staged === unstage);
		if (changes.length === 0) return;

		const startedAt = Date.now();
		const action = unstage ? "Unstage all" : "Stage all";
		this.committing = true;
		let completed = false;
		try {
			if (unstage) {
				await unstageFiles(this.app.vault.adapter, this.plugin.settings.repositoryPath, changes.map((change) => change.path));
			} else {
				await stageFile(this.app.vault.adapter, this.plugin.settings.repositoryPath, changes.map((change) => change.path));
			}
			for (const change of changes) {
				this.selectedPaths.delete(change.path);
				this.plugin.recordActivity(`${unstage ? "Unstaged" : "Staged"} ${change.path}.`);
			}
			completed = true;
		} catch (error) {
			const detail = error instanceof Error ? error.message : "Unable to update all changed files.";
			this.plugin.recordActivity(`Could not update all changed files: ${detail}`, "ERROR");
			new Notice(detail);
		} finally {
			this.committing = false;
		}
		if (completed) this.applyKnownStagingState(changes, !unstage);
		else this.markChangesRefreshRequired(unstage ? "unstage all" : "stage all");
		this.plugin.recordActivity(`${action} completed in ${formatMilliseconds(elapsedMilliseconds(startedAt))} (${changes.length} files).`, "METRIC");
	}

	private async applySelectedStage(unstage: boolean): Promise<void> {
		const selected = (this.changes ?? []).filter((change) =>
			this.selectedPaths.has(change.path) && change.staged === unstage,
		);
		if (selected.length === 0) return;

		const startedAt = Date.now();
		const action = unstage ? "Unstage selected" : "Stage selected";
		this.committing = true;
		let completed = false;
		try {
			if (unstage) {
				await unstageFiles(this.app.vault.adapter, this.plugin.settings.repositoryPath, selected.map((change) => change.path));
			} else {
				await stageFile(this.app.vault.adapter, this.plugin.settings.repositoryPath, selected.map((change) => change.path));
			}
			for (const change of selected) {
				this.plugin.recordActivity(`${unstage ? "Unstaged" : "Staged"} ${change.path}.`);
				this.selectedPaths.delete(change.path);
			}
			completed = true;
		} catch (error) {
			const detail = error instanceof Error ? error.message : "Unable to update selected files.";
			this.plugin.recordActivity(`Could not update selected files: ${detail}`, "ERROR");
			new Notice(detail);
		} finally {
			this.committing = false;
		}
		if (completed) this.applyKnownStagingState(selected, !unstage);
		else this.markChangesRefreshRequired(unstage ? "unstage selected" : "stage selected");
		this.plugin.recordActivity(`${action} completed in ${formatMilliseconds(elapsedMilliseconds(startedAt))} (${selected.length} files).`, "METRIC");
	}

	private async toggleStage(change: ChangedFile): Promise<void> {
		const startedAt = Date.now();
		const action = change.staged ? "Unstage" : "Stage";
		try {
			if (change.staged) {
				await unstageFile(this.app.vault.adapter, this.plugin.settings.repositoryPath, change.path);
				this.plugin.recordActivity(`Unstaged ${change.path}.`);
			} else {
				await stageFile(this.app.vault.adapter, this.plugin.settings.repositoryPath, change.path);
				this.plugin.recordActivity(`Staged ${change.path}.`);
			}
			this.applyKnownStagingState([change], !change.staged);
			this.plugin.recordActivity(`${action} ${change.path} completed in ${formatMilliseconds(elapsedMilliseconds(startedAt))}.`, "METRIC");
		} catch (error) {
			const detail = error instanceof Error ? error.message : "Unable to update staging.";
			this.plugin.recordActivity(`Could not update ${change.path} after ${formatMilliseconds(elapsedMilliseconds(startedAt))}: ${detail}`, "ERROR");
			new Notice(detail);
		}
	}

	private applyKnownStagingState(changes: ChangedFile[], staged: boolean): void {
		const paths = new Set(changes.map((change) => change.path));
		this.changes = this.changes?.map((change) => {
			if (!paths.has(change.path)) return change;
			const status = staged && change.status === "Untracked"
				? "Added"
				: !staged && change.status === "Added"
					? "Untracked"
					: change.status;
			return { ...change, status, staged };
		}) ?? null;
		this.changesError = null;
		this.updateChangesContent();
	}

	private async commit(message: string): Promise<void> {
		const trimmedMessage = message.trim();
		if (!trimmedMessage) {
			new Notice("Enter a commit message.");
			return;
		}
		const authorName = this.plugin.settings.authorName.trim();
		const authorEmail = this.plugin.settings.authorEmail.trim();
		if (!authorName || !authorEmail) {
			new Notice("Enter your commit name and email in Git Sync settings.");
			this.openSettings();
			return;
		}
		const stagedPaths = (this.changes ?? [])
			.filter((change) => change.staged)
			.map((change) => change.path);
		this.committing = true;
		this.render();
		try {
			const oid = await commitChanges(this.app.vault.adapter, this.plugin.settings.repositoryPath, trimmedMessage, {
				name: authorName,
				email: authorEmail,
			});
			this.plugin.recordActivity(`Committed ${oid.slice(0, 7)}: ${trimmedMessage}`);
			this.commitMessage = "";
			new Notice("Commit created.");
			await this.refreshAfterCommit(oid, stagedPaths);
		} catch (error) {
			const detail = error instanceof Error ? error.message : "Unable to create the commit.";
			this.plugin.recordActivity(`Commit failed: ${detail}`, "ERROR");
			new Notice(detail);
		} finally {
			this.committing = false;
			this.render();
		}
	}

	private async refreshAfterCommit(commitOid: string, committedPaths: string[]): Promise<void> {
		const startedAt = Date.now();
		this.applyKnownChangeUpdates(committedPaths, []);
		if (this.repositoryState?.kind === "ready") {
			this.repositoryState = { ...this.repositoryState, head: commitOid };
		}

		try {
			const history = await readCommits(
				this.app.vault.adapter,
				this.plugin.settings.repositoryPath,
				this.commitDepth.get("local") ?? COMMIT_PAGE_SIZE,
			);
			this.commits = this.hydrateCommitChanges(history.commits, this.plugin.settings.repositoryPath);
			this.commitHasMore.set("local", history.hasMore);
			this.commitsError = null;
		} catch (error) {
			this.commitsError = error instanceof Error ? error.message : "Unable to read local commits.";
		}

		this.render();
		this.plugin.recordActivity(
			`Commit refresh completed in ${formatMilliseconds(elapsedMilliseconds(startedAt))} without a full Changes scan.`,
			"METRIC",
		);
	}

	async refreshRemoteHistory(reason = "remote-history-refresh"): Promise<void> {
		const startedAt = Date.now();
		const repositoryPath = this.plugin.settings.repositoryPath.trim();
		if (!repositoryPath || this.repositoryState?.kind !== "ready") {
			this.markChangesRefreshRequired(reason);
			return;
		}

		const generation = ++this.refreshGeneration;
		try {
			const history = await readRemoteCommits(
				this.app.vault.adapter,
				repositoryPath,
				this.plugin.settings.branchName,
				this.commitDepth.get("remote") ?? COMMIT_PAGE_SIZE,
			);
			if (generation !== this.refreshGeneration || !this.contentEl.isConnected) return;
			this.remoteCommits = this.hydrateCommitChanges(history.commits, repositoryPath);
			this.remoteHistoryAvailable = history.available;
			this.commitHasMore.set("remote", history.hasMore);
			this.remoteCommitsError = null;
		} catch (error) {
			if (generation !== this.refreshGeneration || !this.contentEl.isConnected) return;
			this.remoteCommits = null;
			this.remoteHistoryAvailable = false;
			this.commitHasMore.set("remote", false);
			this.remoteCommitsError = error instanceof Error ? error.message : "Unable to read remote commits.";
		}

		this.plugin.recordActivity(
			`Remote history refresh [${reason}] completed in ${formatMilliseconds(elapsedMilliseconds(startedAt))}.`,
			"METRIC",
		);
		if (this.activeTab === "Changes" && this.changesContentEl?.isConnected) {
			this.renderRepositoryContext(this.contentEl, repositoryPath);
			this.updateChangesContent();
		} else {
			this.render();
		}
	}

	markChangesRefreshRequired(reason: string): void {
		this.changesRefreshRequired = true;
		this.changesRefreshReason = reason;
		this.changes = null;
		this.changesError = null;
		this.selectedPaths.clear();
		this.render();
	}

	private async refreshChangesForPaths(
		affectedPaths: string[],
		filepaths: string[],
		reason: string,
	): Promise<void> {
		const startedAt = Date.now();
		const repositoryPath = this.plugin.settings.repositoryPath.trim();
		if (!repositoryPath || this.repositoryState?.kind !== "ready") {
			this.markChangesRefreshRequired(reason);
			return;
		}

		try {
			const updates = await readChanges(this.app.vault.adapter, repositoryPath, filepaths);
			this.applyKnownChangeUpdates(affectedPaths, updates);
			this.plugin.recordActivity(
				`Changes refresh [${reason}] completed for ${filepaths.length} path${filepaths.length === 1 ? "" : "s"} in ${formatMilliseconds(elapsedMilliseconds(startedAt))}.`,
				"METRIC",
			);
		} catch {
			this.markChangesRefreshRequired(reason);
		}
	}

	private applyKnownChangeUpdates(affectedPaths: string[], updates: ChangedFile[]): void {
		const affected = new Set(affectedPaths);
		this.changes = (this.changes ?? [])
			.filter((change) => !affected.has(change.path))
			.concat(updates);
		this.changesError = null;
		const availablePaths = new Set(this.changes.map((change) => change.path));
		for (const selectedPath of this.selectedPaths) {
			if (!availablePaths.has(selectedPath)) this.selectedPaths.delete(selectedPath);
		}
		this.updateChangesContent();
	}

	private updateChangesContent(): void {
		const content = this.changesContentEl;
		if (!content || !content.isConnected || this.activeTab !== "Changes") {
			this.render();
			return;
		}

		this.captureChangesScrollTop();
		const activeElement = content.ownerDocument.activeElement;
		const focusedPath = activeElement instanceof HTMLElement
			? activeElement.getAttribute("data-change-path")
			: null;
		const focusedTextarea = activeElement instanceof HTMLTextAreaElement && content.contains(activeElement);
		const textareaSelection = focusedTextarea && activeElement instanceof HTMLTextAreaElement
			? { start: activeElement.selectionStart, end: activeElement.selectionEnd }
			: null;

		content.empty();
		this.renderChanges(content);
		this.restoreChangesScrollTop(content);

		if (focusedTextarea) {
			const textarea = content.querySelector<HTMLTextAreaElement>(".git-sync-commit textarea");
			if (textarea) {
				textarea.focus();
				if (textareaSelection) textarea.setSelectionRange(textareaSelection.start, textareaSelection.end);
			}
		} else if (focusedPath) {
			const focusedControl = Array.from(content.querySelectorAll<HTMLElement>("[data-change-path]"))
				.find((element) => element.getAttribute("data-change-path") === focusedPath);
			focusedControl?.focus();
		}
	}

	private captureChangesScrollTop(): void {
		if (this.changesContentEl?.isConnected) this.changesScrollTop = this.changesContentEl.scrollTop;
	}

	private restoreChangesScrollTop(content: HTMLElement): void {
		content.scrollTop = this.changesScrollTop;
		window.requestAnimationFrame(() => {
			if (content.isConnected) content.scrollTop = this.changesScrollTop;
		});
	}

	private recordRepositoryActivity(state: RepositoryState): void {
		const message = repositoryActivityMessage(state);
		if (message === this.lastRepositoryActivity) return;
		this.lastRepositoryActivity = message;
		this.plugin.recordActivity(message);
	}

	private renderActivity(content: HTMLElement): void {
		const entries = this.plugin.getActivity();
		if (entries.length === 0) {
			content.createEl("p", {
				text: "No log entries recorded yet.",
				cls: "git-sync-state-description",
			});
			return;
		}

		const list = content.createDiv({ cls: "git-sync-log-list" });
		for (const entry of entries.slice(0, this.activityVisibleCount)) {
			const item = list.createDiv({ cls: "git-sync-log-entry" });
			item.createDiv({ text: formatLogTimestamp(entry.timestamp), cls: "git-sync-log-time" });
			const level = item.createDiv({ text: entry.level, cls: "git-sync-log-level" });
			level.setAttribute("data-log-level", entry.level);
			item.createDiv({ text: entry.message, cls: "git-sync-log-message" });
		}
		if (this.activityVisibleCount < entries.length) {
			const loadMore = content.createEl("button", {
				text: "Load more messages",
				cls: "git-sync-load-more",
				attr: { type: "button" },
			});
			loadMore.addEventListener("click", () => {
				this.activityVisibleCount += ACTIVITY_PAGE_SIZE;
				this.render();
			});
		}
	}

	private renderSettingsPrompt(content: HTMLElement, title: string): void {
		content.createDiv({ cls: "git-sync-state-title", text: title });
		content.createEl("p", {
			text: "Choose a vault-relative repository path in Settings to start using Git Sync.",
			cls: "git-sync-state-description",
		});
		const settingsButton = content.createEl("button", {
			text: "Open Settings",
			cls: "mod-cta",
			attr: { type: "button" },
		});
		settingsButton.addEventListener("click", () => this.openSettings());
	}

	private addRefreshButton(content: HTMLElement): void {
		const refreshButton = content.createEl("button", {
			text: "Refresh repository",
			attr: { type: "button" },
		});
		refreshButton.addEventListener("click", () => void this.refreshRepositoryState());
	}

	private openSettings(): void {
		const settings = (this.app as App & {
			setting: { open: () => void; openTabById: (id: string) => void };
		}).setting;
		settings.open();
		settings.openTabById(this.plugin.manifest.id);
	}
}

class ConfirmActionModal extends Modal {
	constructor(
		app: App,
		private readonly title: string,
		private readonly description: string,
		private readonly onConfirm: () => void,
		private readonly confirmLabel = "Delete",
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: this.title });
		this.contentEl.createEl("p", { text: this.description });
		const actions = this.contentEl.createDiv({ cls: "git-sync-confirm-actions" });
		const cancel = actions.createEl("button", { text: "Cancel", attr: { type: "button" } });
		cancel.addEventListener("click", () => this.close());
		const confirm = actions.createEl("button", { text: this.confirmLabel, cls: "mod-warning", attr: { type: "button" } });
		confirm.addEventListener("click", () => {
			this.close();
			this.onConfirm();
		});
	}
}

class GitSyncSettingTab extends PluginSettingTab {
	private readonly plugin: GitSyncPlugin;

	constructor(app: App, plugin: GitSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("git-sync-settings");
		containerEl.createEl("h2", { text: "Git Sync settings" });
		containerEl.createEl("p", {
			text: "Configure the repository used by this vault.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Repository path")
			.setDesc("Vault-relative path to the Git repository. Use . for the vault root.")
			.addText((text) => {
				text.setPlaceholder("path/to/repository");
				text.setValue(this.plugin.settings.repositoryPath);
				text.onChange((value) => {
					this.plugin.settings.repositoryPath = value.trim();
					this.plugin.scheduleSettingsSave();
				});
			});

		containerEl.createEl("h3", { text: "Updates" });
		new Setting(containerEl)
			.setName("Check for updates on startup")
			.setDesc("Checks GitHub releases at most once per day.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.checkForUpdates).onChange(async (value) => {
					this.plugin.settings.checkForUpdates = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Release channel")
			.setDesc("Development builds follow this branch; stable builds use the latest stable release.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("dev", "Development")
					.addOption("stable", "Stable")
					.setValue(this.plugin.settings.updateChannel)
					.onChange(async (value) => {
						this.plugin.settings.updateChannel = value as "stable" | "dev";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Auto-install stable updates")
			.setDesc("Installs stable releases without prompting. Development builds always require confirmation.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoUpdate).onChange(async (value) => {
					this.plugin.settings.autoUpdate = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Check now")
			.setDesc(`Installed version ${this.plugin.manifest.version}.`)
			.addButton((button) =>
				button.setButtonText("Check for updates").setCta().onClick(async () => {
					button.setDisabled(true);
					button.setButtonText("Checking…");
					try {
						await this.plugin.checkForUpdates(true);
					} finally {
						button.setButtonText("Check for updates");
						button.setDisabled(false);
					}
				}),
			);

		new Setting(containerEl)
			.setName("Available branch builds")
			.setDesc("Browse and install published development builds from any branch.")
			.addButton((button) => button.setButtonText("Browse builds").onClick(() => this.plugin.showAvailableBuilds()));

		new Setting(containerEl)
			.setName("Remote URL")
			.setDesc("HTTP or HTTPS URL for the Git remote.")
			.addText((text) => {
				text.setPlaceholder("https://github.com/user/repository.git");
				text.setValue(this.plugin.settings.remoteUrl);
				text.onChange((value) => {
					this.plugin.settings.remoteUrl = value.trim();
					this.plugin.scheduleSettingsSave();
				});
			});

		new Setting(containerEl)
			.setName("Remote username")
			.setDesc("Username sent with the remote token or password.")
			.addText((text) => {
				text.setPlaceholder("git");
				text.setValue(this.plugin.settings.remoteUsername);
				text.onChange((value) => {
					this.plugin.settings.remoteUsername = value.trim();
					this.plugin.scheduleSettingsSave();
				});
			});

		let revealToken = false;
		let tokenInput: HTMLInputElement | null = null;
		const updateTokenField = (button: HTMLElement): void => {
			if (tokenInput) {
				const token = this.plugin.getRemoteToken() ?? "";
				tokenInput.value = revealToken ? token : maskRemoteToken(token);
				tokenInput.readOnly = !revealToken;
			}
			setIcon(button, revealToken ? "eye-off" : "eye");
			button.setAttribute("aria-label", revealToken ? "Hide remote token" : "Show remote token");
			button.setAttribute("title", revealToken ? "Hide token" : "Show token");
		};
		new Setting(containerEl)
			.setName("Remote token or password")
			.setDesc("Stored in Obsidian SecretStorage and never in plugin settings.")
			.addText((text) => {
				tokenInput = text.inputEl;
				text.inputEl.type = "text";
				text.inputEl.autocomplete = "off";
				text.inputEl.readOnly = true;
				text.setPlaceholder("Enter a token or password");
				text.inputEl.value = maskRemoteToken(this.plugin.getRemoteToken() ?? "");
				text.onChange((value) => {
					if (revealToken) this.plugin.saveRemoteToken(value);
				});
			})
			.addButton((button) => {
				button.buttonEl.empty();
				updateTokenField(button.buttonEl);
				button.onClick(() => {
					revealToken = !revealToken;
					updateTokenField(button.buttonEl);
				});
			});

		new Setting(containerEl)
			.setName("Test remote connection")
			.setDesc("Checks the configured HTTP remote and reports its default branch.")
			.addButton((button) =>
				button.setButtonText("Test connection").onClick(async () => {
					button.setDisabled(true);
					button.setButtonText("Testing…");
					try {
						await this.plugin.checkRemoteConnection();
					} finally {
						button.setButtonText("Test connection");
						button.setDisabled(false);
					}
				}),
			);

		new Setting(containerEl)
			.setName("Branch")
			.setDesc("The branch to use for future sync operations.")
			.addText((text) => {
				text.setPlaceholder("main");
				text.setValue(this.plugin.settings.branchName);
				text.onChange((value) => {
					this.plugin.settings.branchName = value.trim();
					this.plugin.scheduleSettingsSave();
				});
			});

		containerEl.createEl("h3", { text: "Commit identity" });
		containerEl.createEl("p", {
			text: "Used only when creating local commits.",
			cls: "setting-item-description",
		});
		new Setting(containerEl)
			.setName("Commit name")
			.setDesc("Your name in new Git commits.")
			.addText((text) => {
				text.setPlaceholder("Your name");
				text.setValue(this.plugin.settings.authorName);
				text.onChange((value) => {
					this.plugin.settings.authorName = value.trim();
					this.plugin.scheduleSettingsSave();
				});
			});

		new Setting(containerEl)
			.setName("Commit email")
			.setDesc("Your email address in new Git commits.")
			.addText((text) => {
				text.setPlaceholder("you@example.com");
				text.setValue(this.plugin.settings.authorEmail);
				text.onChange((value) => {
					this.plugin.settings.authorEmail = value.trim();
					this.plugin.scheduleSettingsSave();
				});
			});

		containerEl.createEl("p", {
			text: "Settings save automatically when changed.",
			cls: "setting-item-description",
		});

		containerEl.createEl("h3", { text: "Plugin data" });
		containerEl.createEl("p", {
			text: "Export or import versioned settings and activity data. Remote credentials stay in Obsidian SecretStorage and are never included.",
			cls: "setting-item-description",
		});
		new Setting(containerEl)
			.setName("Include activity in exports")
			.setDesc("Adds the recent Activity history to exported files. Disabled by default.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.includeActivityInExports)
				.onChange(async (value) => {
					this.plugin.settings.includeActivityInExports = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName("Export plugin data")
			.setDesc("Writes a timestamped JSON backup to the vault root. Remote credentials are not included.")
			.addButton((button) => button
				.setButtonText("Export to vault")
				.onClick(async () => {
					button.setDisabled(true);
					try {
						const path = await this.plugin.exportDataToVault();
						new Notice(`Plugin data exported to ${path}.`);
					} catch (error) {
						const detail = error instanceof Error ? error.message : "Unknown error";
						this.plugin.recordActivity(`Plugin data export failed: ${detail}`, "ERROR");
						new Notice(`Could not export plugin data: ${detail}`);
					} finally {
						button.setDisabled(false);
					}
				}));
		new Setting(containerEl)
			.setName("Import plugin data")
			.setDesc("Replaces settings and activity from a Git Sync JSON backup. The current remote credential is kept.")
			.addButton((button) => button
				.setButtonText("Import JSON")
				.onClick(() => chooseImportFile(this.plugin)));
	}
}

interface GitProgressModalCallbacks {
	onPhase?: (phase: string) => void;
	onMessage?: (message: string) => void;
}

class GitProgressModal extends Modal {
	private readonly startedAt = Date.now();
	private readonly remoteMessages: string[] = [];
	private elapsedEl: HTMLElement | null = null;
	private phaseEl: HTMLElement | null = null;
	private phaseIconEl: HTMLElement | null = null;
	private percentEl: HTMLElement | null = null;
	private progressEl: HTMLProgressElement | null = null;
	private countEl: HTMLElement | null = null;
	private remoteMessagesEl: HTMLElement | null = null;
	private detailsEl: HTMLElement | null = null;
	private resultEl: HTMLElement | null = null;
	private closeButton: HTMLButtonElement | null = null;
	private elapsedTimer: number | null = null;
	private lastPhase = "";
	private pendingPhase: string | null = null;
	private pendingProgress: RemoteProgressEvent | null = null;
	private pendingMessages: string[] = [];
	private pendingFinish: { state: "Completed" | "Failed"; result: RemoteOperationResult; icon: string; className: string } | null = null;

	constructor(
		app: App,
		private readonly operation: string,
		private readonly branch: string,
		private readonly callbacks: GitProgressModalCallbacks = {},
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("git-sync-progress-modal");
		this.contentEl.empty();
		this.contentEl.addClass("git-sync-progress-content");

		this.contentEl.createDiv({ cls: "git-sync-progress-kicker", text: operationKicker(this.operation) });
		const heading = this.contentEl.createDiv({ cls: "git-sync-progress-heading" });
		heading.createEl("h2", { text: `${this.operation} origin/${this.branch}` });
		this.elapsedEl = heading.createDiv({
			cls: "git-sync-progress-elapsed",
			text: "Time elapsed: 00:00",
		});

		const phase = this.contentEl.createDiv({ cls: "git-sync-progress-phase" });
		this.phaseIconEl = phase.createSpan({ cls: "git-sync-progress-icon" });
		setIcon(this.phaseIconEl, "loader-circle");
		this.phaseEl = phase.createSpan({ text: "Starting operation…" });
		this.percentEl = phase.createSpan({ cls: "git-sync-progress-percent" });
		const spark = this.contentEl.createDiv({ cls: "git-sync-progress-spark", attr: { "aria-hidden": "true" } });
		for (let index = 0; index < 7; index++) spark.createSpan();

		this.progressEl = this.contentEl.createEl("progress", {
			cls: "git-sync-progress-bar",
			attr: { max: "100", value: "0", "aria-label": `${this.operation} progress` },
		});
		this.progressEl.hidden = true;
		this.countEl = this.contentEl.createDiv({ cls: "git-sync-progress-count" });

		this.remoteMessagesEl = this.contentEl.createDiv({ cls: "git-sync-progress-messages" });
		this.remoteMessagesEl.hidden = true;
		this.detailsEl = this.contentEl.createDiv({ cls: "git-sync-progress-details" });
		this.detailsEl.hidden = true;
		this.resultEl = this.contentEl.createDiv({ cls: "git-sync-progress-result" });

		const footer = this.contentEl.createDiv({ cls: "git-sync-progress-footer" });
		this.closeButton = footer.createEl("button", {
			text: "Close",
			attr: { type: "button", "aria-label": "Close Git operation progress" },
		});
		this.closeButton.disabled = true;
		this.closeButton.addEventListener("click", () => this.close());

		this.elapsedTimer = window.setInterval(() => this.updateElapsed(), 1000);
		this.updateElapsed();
		if (this.pendingPhase) this.setPhase(this.pendingPhase);
		if (this.pendingProgress) this.renderProgress(this.pendingProgress);
		for (const message of this.pendingMessages) this.renderRemoteMessage(message);
		this.pendingProgress = null;
		this.pendingMessages = [];
		if (this.pendingFinish) {
			const finish = this.pendingFinish;
			this.pendingFinish = null;
			this.finish(finish.state, finish.result, finish.icon, finish.className);
		}
	}

	onClose(): void {
		if (this.elapsedTimer !== null) {
			window.clearInterval(this.elapsedTimer);
			this.elapsedTimer = null;
		}
		this.contentEl.empty();
	}

	setPhase(phase: string): void {
		const normalized = phase.trim() || "Working…";
		this.lastPhase = normalized;
		if (!this.phaseEl) {
			this.pendingPhase = normalized;
			return;
		}
		this.phaseEl.setText(normalized);
	}

	updateProgress(event: RemoteProgressEvent): void {
		const phase = event.phase.trim() || "Working…";
		if (phase !== this.lastPhase) {
			this.lastPhase = phase;
			this.callbacks.onPhase?.(phase);
		}
		if (!this.phaseEl || !this.progressEl || !this.percentEl || !this.countEl) {
			this.pendingProgress = { ...event, phase };
			return;
		}
		this.renderProgress({ ...event, phase });
	}

	addRemoteMessage(message: string): void {
		const safeMessage = safeRemoteMessage(message);
		if (!safeMessage) return;
		this.callbacks.onMessage?.(safeMessage);
		if (!this.remoteMessagesEl) {
			this.pendingMessages.push(safeMessage);
			return;
		}
		this.renderRemoteMessage(safeMessage);
	}

	complete(result: RemoteOperationResult): void {
		this.finish("Completed", result, "check", "is-complete");
	}

	fail(detail: string): void {
		this.finish("Failed", { summary: "The operation could not be completed.", details: [detail] }, "x", "is-error");
	}

	private renderProgress(event: RemoteProgressEvent): void {
		if (!this.phaseEl || !this.progressEl || !this.percentEl || !this.countEl) return;
		this.phaseEl.setText(event.phase);
		const total = Number(event.total);
		const loaded = Number(event.loaded);
		if (Number.isFinite(total) && total > 0 && Number.isFinite(loaded)) {
			const completed = Math.max(0, Math.floor(loaded));
			const totalCount = Math.floor(total);
			const percent = Math.max(0, Math.min(100, Math.round((completed / totalCount) * 100)));
			this.progressEl.hidden = false;
			this.progressEl.value = percent;
			this.percentEl.setText(`${percent}%`);
			this.countEl.setText(`${completed} / ${totalCount}`);
			this.progressEl.setAttribute("aria-valuetext", `${event.phase}: ${percent}%`);
		} else {
			this.progressEl.hidden = true;
			this.percentEl.setText("");
			this.countEl.setText("Working…");
		}
	}

	private renderRemoteMessage(message: string): void {
		if (!this.remoteMessagesEl) return;
		this.remoteMessagesEl.hidden = false;
		this.remoteMessages.push(message);
		this.remoteMessages.splice(0, Math.max(0, this.remoteMessages.length - 4));
		this.remoteMessagesEl.empty();
		for (const entry of this.remoteMessages) {
			this.remoteMessagesEl.createDiv({
				cls: "git-sync-progress-message",
				text: entry.startsWith("remote:") ? entry : `remote: ${entry}`,
			});
		}
	}

	private finish(state: "Completed" | "Failed", result: RemoteOperationResult, icon: string, className: string): void {
		if (!this.phaseEl || !this.resultEl || !this.closeButton) {
			this.pendingFinish = { state, result, icon, className };
			return;
		}
		if (this.elapsedTimer !== null) {
			window.clearInterval(this.elapsedTimer);
			this.elapsedTimer = null;
		}
		this.updateElapsed();
		this.modalEl.addClass(className);
		if (this.phaseEl) this.phaseEl.setText(state);
		if (this.phaseIconEl) {
			this.phaseIconEl.empty();
			setIcon(this.phaseIconEl, icon);
		}
		this.resultEl.setText(result.summary);
		this.renderDetails(result.details);
		if (this.progressEl && !this.progressEl.hidden && state === "Completed") {
			this.progressEl.value = 100;
			this.percentEl?.setText("100%");
			this.countEl?.setText("Transfer complete");
		} else if (this.countEl) {
			this.countEl.setText(state === "Completed" ? "No transfer needed" : "Transfer stopped");
		}
		this.closeButton.disabled = false;
		this.closeButton.focus();
	}

	private renderDetails(details: string[]): void {
		if (!this.detailsEl) return;
		this.detailsEl.empty();
		this.detailsEl.hidden = details.length === 0;
		for (const detail of details) {
			this.detailsEl.createDiv({ cls: "git-sync-progress-detail", text: detail });
		}
	}

	private updateElapsed(): void {
		this.elapsedEl?.setText(`Time elapsed: ${formatElapsed(Date.now() - this.startedAt)}`);
	}
}

function operationKicker(operation: string): string {
	switch (operation) {
		case "Push": return "Sending your local commits to the remote";
		case "Pull": return "Bringing remote commits into this vault";
		case "Fetch": return "Checking the remote without changing your files";
		case "Clone": return "Setting up a fresh local repository";
		default: return "Git is working";
	}
}

function repositoryActivityMessage(state: RepositoryState): string {
	switch (state.kind) {
		case "missing":
			return `No Git repository found at ${state.repositoryPath}.`;
		case "ready":
			return `Read local repository on ${state.branch}.`;
		case "error":
			return `Could not read repository: ${state.message}`;
		case "checking":
			return `Checking repository at ${state.repositoryPath}.`;
	}
}

function formatLogTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	const pad = (value: number): string => `0${value}`.slice(-2);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatElapsed(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const pad = (value: number): string => `0${value}`.slice(-2);
	return `${hours > 0 ? `${pad(hours)}:` : ""}${pad(minutes)}:${pad(seconds)}`;
}

function safeRemoteMessage(message: string): string {
	return message
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
		.trim()
		.replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, "$1[redacted]@")
		.replace(/\b(token|password|authorization|bearer)\s*[:=]\s*\S+/gi, "$1: [redacted]");
}

function commitTitle(message: string): string {
	return message.split("\n", 1)[0].trim() || "(no commit message)";
}

function formatRelativeCommitTime(timestamp: number): string {
	const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
	if (seconds < 60) return "just now";
	if (seconds < 60 * 60) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 60 * 60 * 24) return `${Math.floor(seconds / (60 * 60))}h ago`;
	if (seconds < 60 * 60 * 24 * 30) return `${Math.floor(seconds / (60 * 60 * 24))}d ago`;
	if (seconds < 60 * 60 * 24 * 365) return `${Math.floor(seconds / (60 * 60 * 24 * 30))}mo ago`;
	return `${Math.floor(seconds / (60 * 60 * 24 * 365))}y ago`;
}

function formatCommitTimestamp(timestamp: number): string {
	return formatLogTimestamp(timestamp * 1000);
}

function formatFileTimestamp(date: Date): string {
	return date.toISOString().replace(/[:.]/g, "-");
}

function chooseImportFile(plugin: GitSyncPlugin): void {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = ".json,application/json";
	input.style.display = "none";
	input.addEventListener("change", () => {
		const file = input.files?.[0];
		input.remove();
		if (!file) return;

		const reader = new FileReader();
		reader.onload = () => {
			void plugin.importData(String(reader.result ?? "")).catch((error) => {
				new Notice(`Could not import plugin data: ${error instanceof Error ? error.message : "Unknown error"}`);
			});
		};
		reader.onerror = () => new Notice("Could not read the selected plugin data file.");
		reader.readAsText(file);
	});
	document.body.appendChild(input);
	input.click();
}

function decodePluginData(value: unknown, allowLegacy: boolean, requireRecognizedData = false): DecodedPluginData {
	if (!isRecord(value)) {
		if (requireRecognizedData) throw new Error("Git Sync data must be a JSON object.");
		return { settings: {}, activity: [], legacy: false };
	}
	if ("format" in value && value.format !== PLUGIN_DATA_FORMAT) {
		throw new Error("This file belongs to a different plugin or data format.");
	}

	if (value.format === PLUGIN_DATA_FORMAT) {
		if (value.schemaVersion !== PLUGIN_DATA_SCHEMA_VERSION) {
			throw new Error(`Unsupported Git Sync data schema: ${String(value.schemaVersion)}.`);
		}
		if (!isRecord(value.settings)) throw new Error("Git Sync data is missing its settings object.");
		return { settings: value.settings as Partial<GitSyncSettings>, activity: value.activity, legacy: false };
	}

	if (!allowLegacy) throw new Error("This is not a Git Sync data file.");
	const legacyKeys = [
		"repositoryPath",
		"remoteUrl",
		"remoteUsername",
		"branchName",
		"authorName",
		"authorEmail",
		"checkForUpdates",
		"updateChannel",
		"autoUpdate",
		"lastUpdateCheck",
		"includeActivityInExports",
		"activity",
	];
	if (requireRecognizedData && !legacyKeys.some((key) => key in value)) {
		throw new Error("The selected file is not Git Sync plugin data.");
	}
	return {
		settings: value as Partial<GitSyncSettings>,
		activity: value.activity,
		legacy: true,
	};
}

function normalizeSettings(value: Partial<GitSyncSettings>): GitSyncSettings {
	const settings = isRecord(value) ? value : {};
	const updateChannel = settings.updateChannel === "stable" ? "stable" : "dev";
	return {
		repositoryPath: nonEmptyString(settings.repositoryPath) || DEFAULT_SETTINGS.repositoryPath,
		remoteUrl: stringValue(settings.remoteUrl),
		remoteUsername: nonEmptyString(settings.remoteUsername) || DEFAULT_SETTINGS.remoteUsername,
		branchName: nonEmptyString(settings.branchName) || DEFAULT_SETTINGS.branchName,
		authorName: stringValue(settings.authorName),
		authorEmail: stringValue(settings.authorEmail),
		checkForUpdates: booleanValue(settings.checkForUpdates, DEFAULT_SETTINGS.checkForUpdates),
		updateChannel,
			autoUpdate: booleanValue(settings.autoUpdate, DEFAULT_SETTINGS.autoUpdate),
			lastUpdateCheck: finiteNumber(settings.lastUpdateCheck, DEFAULT_SETTINGS.lastUpdateCheck),
			includeActivityInExports: booleanValue(settings.includeActivityInExports, DEFAULT_SETTINGS.includeActivityInExports),
		};
}

function normalizeActivity(value: unknown): ActivityEntry[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is Record<string, unknown> => isRecord(entry))
		.filter((entry) => typeof entry.message === "string" && Number.isFinite(entry.timestamp))
		.map((entry): ActivityEntry => ({
			message: String(entry.message),
			timestamp: Number(entry.timestamp),
			level: entry.level === "DEBUG" || entry.level === "METRIC" || entry.level === "ERROR" ? entry.level : "INFO",
		}))
		.slice(0, MAX_ACTIVITY_ENTRIES);
}

function mergeActivity(...sources: ActivityEntry[][]): ActivityEntry[] {
	const seen = new Set<string>();
	const combined = sources.reduce<ActivityEntry[]>((all, source) => all.concat(source), []);
	return combined
		.filter((entry) => {
			const key = activityKey(entry);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((left, right) => right.timestamp - left.timestamp)
		.slice(0, MAX_ACTIVITY_ENTRIES);
}

function activityKey(entry: ActivityEntry): string {
	return `${entry.timestamp}\u0000${entry.level}\u0000${entry.message}`;
}

function serializeActivityEntry(entry: ActivityEntry): string {
	const message = entry.message.replace(/[\r\n]+/g, "\\n");
	return `${new Date(entry.timestamp).toISOString()} [${entry.level}] ${message}`;
}

function parseActivityEntry(line: string): ActivityEntry | null {
	const match = /^(\S+)\s+\[(DEBUG|INFO|METRIC|ERROR)\]\s?(.*)$/.exec(line);
	if (!match) return null;
	const timestamp = Date.parse(match[1]);
	if (!Number.isFinite(timestamp)) return null;
	return {
		timestamp,
		level: match[2] as ActivityLevel,
		message: match[3].replace(/\\n/g, "\n"),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function nonEmptyString(value: unknown): string {
	return stringValue(value).trim();
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function elapsedMilliseconds(startedAt: number): number {
	return Math.max(0, Date.now() - startedAt);
}

function formatMilliseconds(milliseconds: number): string {
	return `${Math.max(0, Math.round(milliseconds))} ms`;
}

function commitFileCode(status: "Added" | "Modified" | "Deleted"): string {
	switch (status) {
		case "Added":
			return "A";
		case "Deleted":
			return "D";
		default:
			return "M";
	}
}

function maskRemoteToken(token: string): string {
	if (!token) return "";
	if (token.length <= 8) return `${token.slice(0, 2)}…${token.slice(-2)}`;
	return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function describeOperationError(error: unknown, fallback: string): string {
	if (error instanceof Error) {
		const details: string[] = [error.message || fallback];
		if (isRecord(error) && typeof error.code === "string") details.push(`code=${error.code}`);
		if (isRecord(error) && typeof error.caller === "string") details.push(`caller=${error.caller}`);
		return details.join(" ");
	}
	return typeof error === "string" && error ? error : fallback;
}

function changeFilterKey(status: string): ChangeStatusFilter {
	if (status === "Untracked") return "Untracked";
	if (status.startsWith("Added")) return "Added";
	if (status.includes("Deleted")) return "Deleted";
	return "Modified";
}

function compareChanges(left: ChangedFile, right: ChangedFile, sort: ChangeSort): number {
	const pathCompare = left.path.localeCompare(right.path, undefined, { sensitivity: "base" });
	if (sort === "path-desc") return -pathCompare;
	if (sort === "status-path") {
		const statusCompare = changeFilterKey(left.status).localeCompare(changeFilterKey(right.status));
		return statusCompare || pathCompare;
	}
	if (sort === "folder-name") {
		const leftParts = left.path.split("/");
		const rightParts = right.path.split("/");
		const folderCompare = leftParts.slice(0, -1).join("/").localeCompare(rightParts.slice(0, -1).join("/"), undefined, { sensitivity: "base" });
		return folderCompare || leftParts[leftParts.length - 1].localeCompare(rightParts[rightParts.length - 1], undefined, { sensitivity: "base" });
	}
	return pathCompare;
}

function changeCode(status: string): string {
	switch (status) {
		case "Untracked":
			return "?";
		case "Added":
			return "A";
		case "Deleted":
		case "Added, deleted":
			return "D";
		default:
			return "M";
	}
}
