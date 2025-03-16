# Obsidian Git Sync Plugin

A Git synchronization plugin for Obsidian that works on desktop and mobile platforms.

## Features

- Synchronize your Obsidian vault with a Git repository
- Works on desktop (Windows, macOS, Linux) and mobile (iOS, Android) platforms
- Automatic and manual sync options
- Configurable commit messages
- Status bar indicator for sync status

## Installation

### From Obsidian Community Plugins

1. Open Obsidian
2. Go to Settings > Community Plugins
3. Disable Safe Mode if necessary
4. Click Browse and search for "Git Sync"
5. Install the plugin
6. Enable the plugin in the Community Plugins tab

### Manual Installation

1. Download the latest release from the GitHub repository
2. Extract the files to your vault's `.obsidian/plugins/obsidian-git-sync` directory
3. Reload Obsidian
4. Enable the plugin in Settings > Community Plugins

## Usage

### Configuration

1. Go to Settings > Git Sync
2. Enter your Git repository URL
3. Configure your Git credentials (username and password/token)
4. Set your author name and email for commits
5. Configure auto-sync interval if desired

### Manual Sync

Click the Git Sync icon in the ribbon to manually sync your vault.

### Automatic Sync

Enable automatic sync by setting a non-zero interval in the settings.

## How It Works

This plugin uses [isomorphic-git](https://isomorphic-git.org/), a pure JavaScript implementation of Git, to provide Git functionality across all platforms, including mobile devices where traditional Git clients are not available.

## Troubleshooting

- **Authentication Issues**: Make sure your username and password/token are correct. For GitHub, you'll need to use a Personal Access Token instead of your password.
- **Sync Failures**: Check the console logs for more detailed error messages.

## Development

### Building the Plugin

```bash
# Install dependencies
npm install

# Build the plugin
npm run build
```

### Development Mode

```bash
npm run dev
```

## License

MIT