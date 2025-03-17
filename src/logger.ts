/**
 * Logger utility for Obsidian Git Sync plugin
 * Provides consistent logging functionality with different log levels
 */

import { Notice } from 'obsidian';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export class Logger {
  private static instance: Logger;
  private logLevel: LogLevel = LogLevel.INFO;
  private showNotices: boolean = true;

  private constructor() {}

  /**
   * Get the singleton instance of the logger
   */
  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /**
   * Set the minimum log level to display
   */
  public setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  /**
   * Set whether to show notices for warnings and errors
   */
  public setShowNotices(show: boolean): void {
    this.showNotices = show;
  }

  /**
   * Log a debug message
   */
  public debug(context: string, message: string, data?: any): void {
    if (this.logLevel <= LogLevel.DEBUG) {
      console.debug(`[Git Sync][${context}] ${message}`, data || '');
    }
  }

  /**
   * Log an info message
   */
  public info(context: string, message: string, data?: any): void {
    if (this.logLevel <= LogLevel.INFO) {
      console.info(`[Git Sync][${context}] ${message}`, data || '');
    }
  }

  /**
   * Log a warning message
   */
  public warn(context: string, message: string, data?: any): void {
    if (this.logLevel <= LogLevel.WARN) {
      console.warn(`[Git Sync][${context}] ${message}`, data || '');
      if (this.showNotices) {
        new Notice(`[Warning] ${message}`);
      }
    }
  }

  /**
   * Log an error message
   */
  public error(context: string, message: string, error?: Error): void {
    if (this.logLevel <= LogLevel.ERROR) {
      console.error(`[Git Sync][${context}] ${message}`, error || '');
      if (error?.stack) {
        console.error(`[Git Sync][${context}] Stack trace:`, error.stack);
      }
      if (this.showNotices) {
        new Notice(`[Error] ${message}${error ? `: ${error.message}` : ''}`);
      }
    }
  }
}

// Export a default instance for easy import
export const log = Logger.getInstance();