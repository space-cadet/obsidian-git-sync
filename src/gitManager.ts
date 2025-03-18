import simpleGit, { SimpleGit } from 'simple-git';
import { log } from './logger';
import fs from 'fs';
import path from 'path';
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
    private git: SimpleGit;
    private dir: string;
    private credentials: GitCredentials;
    private statusBarItem: HTMLElement | null = null;

    constructor(dir: string, credentials: GitCredentials, statusBarItem?: HTMLElement) {
        this.dir = dir;
        this.credentials = credentials;
        this.statusBarItem = statusBarItem || null;

        // Initialize simple-git with the working directory
        this.git = simpleGit(this.dir);
        
        // Removed configuration from constructor. Configuration will be set during repository initialization.
    }

    private updateStatus(message: string) {
        if (this.statusBarItem) {
            this.statusBarItem.setText(`Git: ${message}`);
        }
        log.info('GitManager', message);
    }

    /**
     * Initialize a new repository or check if one exists
     */
    async initializeRepo(repoUrl: string, branchName: string): Promise<boolean> {
        try {
            log.debug('GitManager', `Initializing repository: ${repoUrl}, branch: ${branchName}`);
            
            const isRepo = await this.isRepository();
            
            if (!isRepo) {
                this.updateStatus('Cloning repository...');
                log.info('GitManager', `Cloning repository from ${repoUrl} (branch: ${branchName})`);
                
                // Set up authentication for HTTPS
                const remoteWithAuth = repoUrl.replace('https://', 
                    `https://${this.credentials.username}:${this.credentials.password}@`);
                
                // Clone the repository
                await this.git.clone(remoteWithAuth, this.dir, [
                    '--single-branch',
                    '--branch', branchName,
                    '--depth', '1'
                ]);
                
                // Set git credentials in the cloned repository after cloning
                await this.git.addConfig('user.name', this.credentials.author.name);
                await this.git.addConfig('user.email', this.credentials.author.email);
                
                this.updateStatus('Repository cloned');
                log.info('GitManager', `Repository successfully cloned to ${this.dir}`);
                return true;
            }
            
            this.updateStatus('Repository already exists');
            log.info('GitManager', `Repository already exists at ${this.dir}`);
            return true;
        } catch (error) {
            log.error('GitManager', 'Failed to initialize repository', error);
            this.updateStatus('Failed to initialize');
            throw error;
        }
    }
    
        async testConnection(repoUrl: string): Promise<boolean> {
            try {
                const remoteWithAuth = repoUrl.replace('https://', `https://${this.credentials.username}:${this.credentials.password}@`);
                log.debug('GitManager', `Testing remote connection to ${remoteWithAuth}`);
                await this.git.listRemote([remoteWithAuth]);
                this.updateStatus('Connection successful');
                log.info('GitManager', `Connection to ${remoteWithAuth} successful`);
                return true;
            } catch (error) {
                log.error('GitManager', 'Test connection failed', error);
                this.updateStatus('Connection failed');
                throw error;
            }
        }

    /**
     * Check if the current directory is a git repository
     */
    async isRepository(): Promise<boolean> {
        try {
            log.debug('GitManager', `Checking if ${this.dir} is a repository`);
            return await this.git.checkIsRepo();
        } catch (error) {
            log.error('GitManager', `Error checking if ${this.dir} is a repository`, error);
            return false;
        }
    }

    /**
     * Pull changes from the remote repository
     */
    async pull(branchName: string): Promise<void> {
        try {
            this.updateStatus('Pulling changes...');
            
            await this.git.pull('origin', branchName);
            
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
            await this.git.add('.');
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
        const isRepo = await this.isRepository();
        if (!isRepo) {
            this.updateStatus('Not a git repository');
            return [];
        }
        try {
            const status = await this.git.status();
            return [
                ...status.modified,
                ...status.not_added,
                ...status.created,
                ...status.deleted,
                ...status.renamed.map(file => file.to)
            ];
        } catch (error) {
            console.error('Failed to get changed files:', error);
            throw error;
        }
    }
            
            /**
             * Get git log entries in a formatted string.
             */
            async getGitLog(): Promise<string> {
                const isRepo = await this.isRepository();
                if (!isRepo) {
                    this.updateStatus('Not a git repository');
                    return 'Not a git repository';
                }
                try {
                    const logData = await this.git.log();
                    return logData.all.map(entry => `${entry.date} - ${entry.message} (${entry.author_name})`).join('\n');
                } catch (error) {
                    console.error('Failed to get git log:', error);
                    throw error;
                }
            }

    /**
     * Commit staged changes
     */
    async commit(message: string): Promise<void> {
        try {
            this.updateStatus('Committing changes...');
            await this.git.commit(message);
            this.updateStatus('Changes committed');
        } catch (error) {
            console.error('Failed to commit changes:', error);
            this.updateStatus('Commit failed');
            throw error;
        }
    }

    /**
     * Push changes to remote repository
     */
    async push(branchName: string): Promise<void> {
        try {
            this.updateStatus('Pushing changes...');
            await this.git.push('origin', branchName);
            this.updateStatus('Push completed');
        } catch (error) {
            console.error('Failed to push changes:', error);
            this.updateStatus('Push failed');
            throw error;
        }
    }

    /**
     * Sync changes with remote repository
     */
    async sync(repoUrl: string, branchName: string, commitMessage: string): Promise<void> {
        try {
            // Initialize repository if needed
            await this.initializeRepo(repoUrl, branchName);
            
            // Pull latest changes
            await this.pull(branchName);
            
            // Add and commit changes
            await this.addAll();
            await this.commit(commitMessage);
            
            // Push changes
            await this.push(branchName);
        } catch (error) {
            console.error('Sync failed:', error);
            throw error;
        }
    }
}