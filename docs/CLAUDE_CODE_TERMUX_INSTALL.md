# Claude Code on Termux (Android)

This guide documents the working installation path tested on an Android ARM64 device running native Termux. It explains why the normal installer failed and how the community-maintained `claude-code-android` migration script made Claude Code launch successfully.

> **Important:** Claude Code itself is Anthropic's product, but the Android compatibility installer described here is **not an official Anthropic installer**. Review and trust the third-party project before running its scripts. This guide records the procedure that worked in one environment; it is not a guarantee for every device or future release.

## Tested environment and result

Observed during the installation on 2026-10-17:

- Environment: native Termux on Android (not Debian/proot).
- Architecture: `uname -m` returned `aarch64`.
- Node.js reported `android arm64` (Node.js 24.18.0).
- npm global package installation: `@anthropic-ai/claude-code` 2.1.302.
- The standard Anthropic installer and npm installation did not produce a runnable native binary for Android.
- The community migration completed successfully, verified the downloaded binary checksum, smoke-tested it, and installed a wrapper.
- Final check: `claude --version` returned `2.1.302 (Claude Code)`.

The version above is the version observed during this test, not a promise that it will remain the latest version.

## Why the normal install failed

The device identifies itself to Node.js as:

```text
android arm64
```

The official installer attempted to run a Linux ARM64 executable and failed with an error similar to:

```text
cannot execute: required file not found
```

Installing through npm also initially failed. Running the package's postinstall script made the underlying cause explicit:

```text
Native binaries for linux-arm64-android are not available on this release channel.
Available: darwin-arm64, darwin-x64, linux-x64, linux-arm64,
linux-x64-musl, linux-arm64-musl, win32-x64, win32-arm64
```

Allowing npm install scripts did not solve this platform mismatch. Repeating the official installer or reinstalling the same npm package is not the fix.

## 1. Repair Termux packages first (if needed)

If `pkg update` reports that no mirror is selected, choose one:

```bash
termux-change-repo
```

Select **Main repository**, then choose a mirror group (for example, **Mirrors in Asia**) and confirm.

If `curl` fails with an SSL symbol error such as:

```text
CANNOT LINK EXECUTABLE "curl": cannot locate symbol "SSL_set_quic_tls_early_data_enabled"
```

run the package upgrade using `apt`:

```bash
apt update
apt full-upgrade -y
```

Resolve any interactive package configuration prompts as appropriate. Then confirm that `curl` works:

```bash
curl --version
```

Install basic requirements if needed:

```bash
pkg install curl nodejs-lts -y
```

## 2. Confirm the environment

Run these commands in **native Termux**, not inside a proot container:

```bash
uname -m
node -p "process.platform + ' ' + process.arch"
node -v
npm -v
```

The tested device reported `aarch64` and `android arm64`.

## 3. Understand the third-party migration

The working procedure used the community project:

- Repository: https://github.com/ferrumclaudepilgrim/claude-code-android
- Migration script: https://github.com/ferrumclaudepilgrim/claude-code-android/blob/main/migrate.sh
- Project README/install guide: https://github.com/ferrumclaudepilgrim/claude-code-android

The migration script is intended for an existing pinned v2.x installation. Its output said it would:

1. Back up `~/.claude`, `~/.claude.json`, and `~/.bashrc` to a timestamped backup directory.
2. Download the Linux ARM64 Claude Code binary and verify it against the published checksum manifest.
3. Patch the binary for the Termux environment using the project's compatibility setup.
4. Replace the previous install and install a wrapper at `$PREFIX/bin/claude`.
5. Merge settings and optionally install recommended packages.

The migration output also showed a GLIBC compatibility setup (including `glibc-runner` and `patchelf-glibc`) and a DNS resolver preload. These are part of the third-party workaround, not official Anthropic components.

**Security note:** A shell script downloaded from GitHub can modify files and install packages. Read the script before running it, confirm the repository owner and project are the ones you intend to trust, and keep the backup path printed by the script. Do not run it while a Claude session is active.

## 4. Download and inspect the migration script

The commands used were:

```bash
curl -fsSL https://raw.githubusercontent.com/ferrumclaudepilgrim/claude-code-android/main/migrate.sh -o migrate.sh
less migrate.sh
```

Press `q` to exit `less`.

Only continue if you have reviewed and trust the script. The project says this migration is for an existing pinned v2.x install; for a fresh installation, consult the project's current README and use its recommended fresh-install path instead.

## 5. Run the migration

Close any running Claude Code sessions, then run:

```bash
bash migrate.sh
```

The script asks two confirmation questions.

At:

```text
Install recommended packages? [Y/n]
```

- Enter `y` to install the optional recommended tools, or `n` if you manage them yourself.
- The recommended list shown during this test included tools such as `git`, `gh`, `wget`, `jq`, `python`, `openssh`, `tree`, `proot`, `proot-distro`, `make`, and `clang`.

At:

```text
Proceed? [y/N]
```

Enter `y` only after reviewing the planned changes and accepting the third-party script's actions. Entering `n` or pressing Enter aborts the migration without changes.

During the successful run, the script reported that it:

- Created a timestamped backup.
- Upgraded packages and installed compatibility dependencies.
- Resolved version `2.1.302` from the npm registry.
- Downloaded the Linux ARM64 binary (the script estimated about 233 MB).
- Verified the checksum.
- Smoke-tested the binary successfully on the device.
- Removed the old pinned npm installation and installed the wrapper.
- Completed the migration.

The download size and exact version can change in later releases.

## 6. Verify and launch Claude Code

After the migration finishes, close and reopen Termux so shell startup and PATH changes are applied. Then run:

```bash
claude --version
claude
```

The successful test returned:

```text
2.1.302 (Claude Code)
```

If Claude asks you to authenticate, complete the login flow using your own Anthropic account. A successful version check proves that the CLI launches; it does not, by itself, prove that authentication or network access is working.

The test output included a notice that the updater could not query the npm registry and used the cached version. If this appears, check the device's network/DNS connectivity and try again later; do not assume an update check succeeded.

## 7. Backup and recovery

The migration prints the exact backup path and a restore command. Keep that output. The observed run created a path shaped like:

```text
~/claude-migration-backup-YYYYMMDD-HHMMSS
```

To restore, use the **exact path printed by your own migration run**, for example:

```bash
bash ~/claude-migration-backup-YYYYMMDD-HHMMSS/restore.sh
```

The example timestamp above is a placeholder; it is not a literal directory name.

The successful run printed `Sessions: 0 preserved`, while also stating that login and chats were intact. Treat the backup as the recovery source and verify your own session history rather than assuming that every active session was migrated.

## Troubleshooting

### `claude native binary not installed`

This was the state before migration. The normal npm package did not provide a native binary for `android arm64`. Do not keep repeating `npm install -g @anthropic-ai/claude-code`; follow the compatibility project's current documented path instead.

### `cannot execute: required file not found`

This can indicate that the executable's expected Linux runtime is not available in native Termux. In this case it occurred when the official installer attempted to launch the Linux ARM64 binary. The migration's compatibility layer was the part that resolved the launch problem on the tested device.

### `curl` SSL linker error

Choose a Termux mirror, then run `apt update` and `apt full-upgrade -y`. Verify `curl --version` before downloading any installer.

### The version command works, but Claude cannot connect

Check the internet connection and DNS. The third-party project installs a DNS preload as part of its workaround, but that does not guarantee that every network will work. Review the project's current troubleshooting guide before changing system files.

## Official vs. community components

- **Claude Code CLI:** Anthropic's product.
- **Official installer:** did not work directly in the tested native Termux environment because the release did not offer a `linux-arm64-android` binary.
- **Compatibility installer/migration and wrapper:** community-maintained by `ferrumclaudepilgrim/claude-code-android`; not an official Anthropic-supported Termux installation path.
- **Verification:** the tested migration verified the binary checksum and successfully launched it, but the community compatibility layer remains a separate third-party component.

## References

- Anthropic Claude Code documentation: https://docs.anthropic.com/en/docs/claude-code/getting-started
- Community project: https://github.com/ferrumclaudepilgrim/claude-code-android
- Migration script: https://github.com/ferrumclaudepilgrim/claude-code-android/blob/main/migrate.sh
