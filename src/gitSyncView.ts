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
        
        // Create tab header container
        const tabHeader = this.containerEl.createEl('div', { cls: 'tab-header' });
        const gitLogTabButton = tabHeader.createEl('button', { text: 'Git Log', cls: 'tab-button active' });
        const gitStatusTabButton = tabHeader.createEl('button', { text: 'Git Status', cls: 'tab-button' });
        
        // Create content container
        const contentContainer = this.containerEl.createEl('div', { cls: 'tab-content' });
        
        // Function to set active tab and load content
        const setActiveTab = async (tabName: string) => {
            // Clear content
            contentContainer.empty();
            // Update active state on buttons
            [gitLogTabButton, gitStatusTabButton].forEach(btn => {
                btn.toggleClass('active', btn.innerText === tabName);
            });
            // Load content based on active tab
            if (tabName === 'Git Log') {
                if (this.plugin.gitManager) {
                    try {
                        const logOutput = await this.plugin.gitManager.getGitLog();
                        contentContainer.createEl('pre', { text: logOutput });
                    } catch (e) {
                        contentContainer.createEl('pre', { text: 'Error fetching git log.' });
                    }
                } else {
                    contentContainer.createEl('pre', { text: 'Git manager not initialized.' });
                }
            } else if (tabName === 'Git Status') {
                if (this.plugin.gitManager) {
                    try {
                        const files = await this.plugin.gitManager.getChangedFiles();
                        const statusOutput = files.length > 0 ? files.join('\n') : 'No changes detected.';
                        contentContainer.createEl('pre', { text: statusOutput });
                    } catch (e) {
                        contentContainer.createEl('pre', { text: 'Error fetching git status.' });
                    }
                } else {
                    contentContainer.createEl('pre', { text: 'Git manager not initialized.' });
                }
            }
        };
        // Add event listeners for tab buttons
        gitLogTabButton.onclick = async () => await setActiveTab('Git Log');
        gitStatusTabButton.onclick = async () => await setActiveTab('Git Status');
        // Initialize with Git Log tab active
        await setActiveTab('Git Log');
        // Initialize with Git Log tab active
        setActiveTab('Git Log');
    }

    async onClose() {}
}