import * as git from 'isomorphic-git';
import * as http from 'isomorphic-git/http/web';
import * as fs from '@isomorphic-git/lightning-fs';
import { Notice } from 'obsidian';

export interface GitCredentials {
    username: string;
    password: string;
    author: {
        name: string;
        email: string;
    };
}

export class GitManager {
    private fs: any;
    private dir: string;
    private credentials: GitCredentials;
    private statusBarItem: HTMLElement | null = null;

    constructor(fs: any, dir: string, credentials: GitCredentials, statusBarItem?: HTMLElement) {
        this.fs = fs;
        this.dir = dir;
        this.credentials = credentials;
        this.statusBarItem = statusBarItem || null;
    }

    private updateStatus(message: string) {
        if (this.statusBarItem) {
            this.statusBarItem.setText(`Git: ${message}`);
        }
        console.log(`Git status: ${message}`);
    }

    /**
     * Initialize a new repository or check if one exists
     */
    async initializeRepo(repoUrl: string, branchName: string): Promise<boolean> {
        try {
            // Check if .git directory exists
            const isRepo = await this.isRepository();
            
            if (!isRepo) {
                this.updateStatus('Cloning repository...');
                
                // Clone the repository
                await git.clone({
                    fs: this.fs,
                    http,
                    dir: this.dir,
                    url: repoUrl,
                    ref: branchName,
                    singleBranch: true,
                    depth: 1,
                    onAuth: () => ({
                        username: this.credentials.username,
                        password: this.credentials.password
                    })
                });
                
                this.updateStatus('Repository cloned');
                return true;
            }
            
            this.updateStatus('Repository already exists');
            return true;
        } catch (error) {
            console.error('Failed to initialize repository:', error);
            this.updateStatus('Failed to initialize');
            throw error;
        }
    }

    /**
     * Check if the current directory is a git repository
     */
    async isRepository(): Promise<boolean> {
        try {
            await git.findRoot({ fs: this.fs, filepath: this.dir });
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Pull changes from the remote repository
     */
    async pull(branchName: string): Promise<void> {
        try {
            this.updateStatus('Pulling changes...');
            
            await git.pull({
                fs: this.fs,
                http,
                dir: this.dir,
                ref: branchName,
                singleBranch: true,
                onAuth: () => ({
                    username: this.credentials.username,
                    password: this.credentials.password
                })
            });
            
            this.updateStatus('Pull completed');
        } catch (error) {
            console.error('Failed to pull changes:', error);
            this.updateStatus('Pull failed');
            throw error;
        }
    }

    /**
     * Add all changes to staging
     */
    async addAll(): Promise<void> {
        try {
            this.updateStatus('Adding changes...');
            
            // Get all files in the directory
            const files = await this.getChangedFiles();
            
            // Add each file to staging
            for (const file of files) {
                await git.add({
                    fs: this.fs,
                    dir: this.dir,
                    filepath: file
                });
            }
            
            this.updateStatus('Changes added');
        } catch (error) {
            console.error('Failed to add changes:', error);
            this.updateStatus('Failed to add changes');
            throw error;
        }
    }

    /**
     * Get a list of all changed files
     */
    async getChangedFiles(): Promise<string[]> {
        try {
            const statusMatrix = await git.statusMatrix({
                fs: this.fs,
                dir: this.dir
            });
            
            // Filter for files that have changes
            return statusMatrix
                .filter(row => row[1] !== row[2] || row[1] !== row[3])
                .map(row => row[0]);
        } catch (error) {
            console.error('Failed to get changed files:', error);
            throw error;
        }
    }

    /**
     * Commit changes with a message
     */
    async commit(message: string): Promise<string> {
        try {
            this.updateStatus('Committing changes...');
            
            const sha = await git.commit({
                fs: this.fs,
                dir: this.dir,
                message,
                author: {
                    name: this.credentials.author.name || 'Obsidian Git Sync',
                    email: this.credentials.author.email || 'obsidian@example.com'
                }
            });
            
            this.updateStatus('Changes committed');
            return sha;
        } catch (error) {
            console.error('Failed to commit changes:', error);
            this.updateStatus('Commit failed');
            throw error;
        }
    }

    /**
     * Push changes to the remote repository
     */
    async push(branchName: string): Promise<void> {
        try {
            this.updateStatus('Pushing changes...');
            
            await git.push({
                fs: this.fs,
                http,
                dir: this.dir,
                remote: 'origin',
                ref: branchName,
                onAuth: () => ({
                    username: this.credentials.username,
                    password: this.credentials.password
                })
            });
            
            this.updateStatus('Push completed');
        } catch (error) {
            console.error('Failed to push changes:', error);
            this.updateStatus('Push failed');
            throw error;
        }
    }

    /**
     * Get the current status of the repository
     */
    async getStatus(): Promise<{ branch: string; ahead: number; behind: number; }> {
        try {
            const currentBranch = await git.currentBranch({
                fs: this.fs,
                dir: this.dir,
                fullname: false
            });
            
            if (!currentBranch) {
                throw new Error('Not on a branch');
            }
            
            // Get ahead/behind counts
            const [ahead, behind] = await Promise.all([
                git.log({
                    fs: this.fs,
                    dir: this.dir,
                    ref: `${currentBranch}..origin/${currentBranch}`
                }).then(commits => commits.length).catch(() => 0),
                git.log({
                    fs: this.fs,
                    dir: this.dir,
                    ref: `origin/${currentBranch}..${currentBranch}`
                }).then(commits => commits.length).catch(() => 0)
            ]);
            
            return {
                branch: currentBranch,
                ahead,
                behind
            };
        } catch (error) {
            console.error('Failed to get repository status:', error);
            throw error;
        }
    }

    /**
     * Perform a full sync operation: pull, add, commit, push
     */
    async sync(repoUrl: string, branchName: string, commitMessage: string): Promise<void> {
        try {
            // Initialize or check repository
            await this.initializeRepo(repoUrl, branchName);
            
            // Pull changes first
            await this.pull(branchName);
            
            // Check if there are changes to commit
            const changedFiles = await this.getChangedFiles();
            
            if (changedFiles.length > 0) {
                // Add all changes
                await this.addAll();
                
                // Commit changes
                await this.commit(commitMessage);
                
                // Push changes
                await this.push(branchName);
                
                new Notice(`Git sync completed: ${changedFiles.length} files updated`);
            } else {
                new Notice('Git sync completed: No changes to commit');
            }
            
            this.updateStatus('Ready');
        } catch (error) {
            this.updateStatus('Sync failed');
            throw error;
        }
    }
}