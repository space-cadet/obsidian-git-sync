import { ItemView, WorkspaceLeaf } from 'obsidian';
import GitSyncPlugin from './main';

export const VIEW_TYPE_GITSYNC = "obsidian-git-sync-view";

export class GitSyncView extends ItemView {
    plugin: GitSyncPlugin;

    constructor(leaf: WorkspaceLeaf, plugin: GitSyncPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return VIEW_TYPE_GITSYNC;
    }

    getDisplayText(): string {
        return "Git Sync";
    }

    async onOpen() {
        this.containerEl.empty();
        this.containerEl.createEl('h2', { text: "Git Sync Sidebar" });
        this.containerEl.createEl('p', { text: "Your Git status and quick actions will appear here." });
    }

    async onClose() {}
}