import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	Notice,
	MarkdownView,
	moment,
} from "obsidian";

// ── Settings ────────────────────────────────────────────────────────

interface DispatchSettings {
	websiteRepo: string; // path to website2 repo (for publish status checks)
	blogFolder: string; // folder in vault to scan (default: "blog")
	defaultVisibility: "public" | "unlisted";
}

const DEFAULT_SETTINGS: DispatchSettings = {
	websiteRepo: "",
	blogFolder: "blog",
	defaultVisibility: "public",
};

// ── Main Plugin ─────────────────────────────────────────────────────

export default class DispatchCompanion extends Plugin {
	settings: DispatchSettings = DEFAULT_SETTINGS;
	statusBarEl: HTMLElement | null = null;

	async onload() {
		await this.loadSettings();

		// ── Status bar ──────────────────────────────────────────
		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar();

		// Refresh status bar when files change
		this.registerEvent(
			this.app.vault.on("modify", () => this.updateStatusBar())
		);
		this.registerEvent(
			this.app.vault.on("create", () => this.updateStatusBar())
		);
		this.registerEvent(
			this.app.vault.on("delete", () => this.updateStatusBar())
		);

		// ── Commands ────────────────────────────────────────────

		this.addCommand({
			id: "new-blog-post",
			name: "New blog post",
			callback: () => this.createBlogPost(),
		});

		this.addCommand({
			id: "set-unlisted",
			name: "Toggle unlisted",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.isBlogFile(file)) return false;
				if (!checking) this.toggleFrontmatter(file, "unlisted");
				return true;
			},
		});

		this.addCommand({
			id: "set-password",
			name: "Set password...",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.isBlogFile(file)) return false;
				if (!checking) this.promptPassword(file);
				return true;
			},
		});

		this.addCommand({
			id: "remove-password",
			name: "Remove password",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.isBlogFile(file)) return false;
				if (!checking) this.removeFrontmatterKey(file, "password");
				return true;
			},
		});

		this.addCommand({
			id: "remove-draft-true",
			name: "Remove legacy draft: true",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) this.removeFrontmatterKey(file, "draft");
				return true;
			},
		});

		this.addCommand({
			id: "show-publish-status",
			name: "Show publish status",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.isBlogFile(file)) return false;
				if (!checking) this.showPublishStatus(file);
				return true;
			},
		});

		// ── Settings tab ────────────────────────────────────────
		this.addSettingTab(new DispatchSettingTab(this.app, this));
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ── Status bar ──────────────────────────────────────────────

	updateStatusBar() {
		if (!this.statusBarEl) return;

		const blogFolder = this.settings.blogFolder;
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(blogFolder + "/"));

		const total = files.length;
		if (total === 0) {
			this.statusBarEl.setText("");
			return;
		}

		// Count files that have published_url in frontmatter
		let published = 0;
		let drafts = 0;
		for (const file of files) {
			const cache = this.app.metadataCache.getFileCache(file);
			const fm = cache?.frontmatter;
			if (fm?.["published_url"]) {
				published++;
			} else {
				drafts++;
			}
		}

		this.statusBarEl.setText(`${drafts} drafts · ${published} live`);
		this.statusBarEl.setAttribute(
			"aria-label",
			`Dispatch: ${drafts} unpublished drafts, ${published} published posts`
		);
	}

	// ── Helpers ─────────────────────────────────────────────────

	isBlogFile(file: TFile): boolean {
		return file.path.startsWith(this.settings.blogFolder + "/");
	}

	/** Create a new blog post with proper frontmatter */
	async createBlogPost() {
		const title = await this.promptText("Blog post title");
		if (!title) return;

		const slug = title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "");

		const year = moment().format("YYYY");
		const date = moment().format("YYYY-MM-DDTHH:mm:ssZ");
		const folderPath = `${this.settings.blogFolder}/${year}`;
		const filePath = `${folderPath}/${slug}.md`;

		// Check if file already exists
		if (this.app.vault.getAbstractFileByPath(filePath)) {
			new Notice(`File already exists: ${filePath}`);
			return;
		}

		// Ensure year folder exists
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!folder) {
			await this.app.vault.createFolder(folderPath);
		}

		// Build frontmatter
		const visibility =
			this.settings.defaultVisibility === "unlisted"
				? "\nunlisted: true"
				: "";
		const content = `---\ndate: ${date}\ntags: []${visibility}\n---\n\n# ${title}\n\n`;

		const file = await this.app.vault.create(filePath, content);
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);

		// Place cursor at end
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) {
			const editor = view.editor;
			editor.setCursor(editor.lastLine());
		}

		new Notice(`Created ${slug}`);
	}

	/** Toggle a boolean frontmatter key */
	async toggleFrontmatter(file: TFile, key: string) {
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			if (fm[key]) {
				delete fm[key];
				new Notice(`Removed ${key}`);
			} else {
				fm[key] = true;
				new Notice(`Set ${key}: true`);
			}
		});
	}

	/** Remove a frontmatter key entirely */
	async removeFrontmatterKey(file: TFile, key: string) {
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			if (key in fm) {
				delete fm[key];
				new Notice(`Removed ${key} from frontmatter`);
			} else {
				new Notice(`No ${key} field found`);
			}
		});
	}

	/** Prompt for a password and set it in frontmatter */
	async promptPassword(file: TFile) {
		const password = await this.promptText("Password for this post");
		if (!password) return;

		await this.app.fileManager.processFrontMatter(file, (fm) => {
			fm["password"] = password;
			// password implies unlisted
			fm["unlisted"] = true;
		});

		new Notice("Password set (implies unlisted)");
	}

	/** Show publish status as a Notice */
	async showPublishStatus(file: TFile) {
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;

		const lines: string[] = [];
		const slug = file.basename;

		if (fm?.["published_url"]) {
			lines.push(`Published: ${fm["published_url"]}`);
		} else {
			lines.push("Not published");
		}

		if (fm?.["password"]) {
			lines.push("Protected (password required)");
		} else if (fm?.["unlisted"]) {
			lines.push("Unlisted (link only)");
		} else {
			lines.push("Public (will appear in listings)");
		}

		if (fm?.["draft"]) {
			lines.push("Has legacy draft: true (run 'Remove legacy draft: true' to clean up)");
		}

		if (!fm?.["date"]) {
			lines.push("Missing date (Dispatch will warn)");
		}

		new Notice(lines.join("\n"), 8000);
	}

	/** Simple text prompt using a modal */
	promptText(placeholder: string): Promise<string | null> {
		return new Promise((resolve) => {
			const modal = new TextInputModal(this.app, placeholder, resolve);
			modal.open();
		});
	}
}

// ── Text Input Modal ────────────────────────────────────────────────

import { Modal } from "obsidian";

class TextInputModal extends Modal {
	placeholder: string;
	resolve: (value: string | null) => void;
	value = "";

	constructor(
		app: App,
		placeholder: string,
		resolve: (value: string | null) => void
	) {
		super(app);
		this.placeholder = placeholder;
		this.resolve = resolve;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.placeholder });

		const input = contentEl.createEl("input", {
			type: "text",
			placeholder: this.placeholder,
		});
		input.style.width = "100%";
		input.style.padding = "8px";
		input.style.marginBottom = "12px";
		input.focus();

		input.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter") {
				this.value = input.value;
				this.close();
			}
			if (e.key === "Escape") {
				this.close();
			}
		});
	}

	onClose() {
		this.resolve(this.value || null);
		this.contentEl.empty();
	}
}

// ── Settings Tab ────────────────────────────────────────────────────

class DispatchSettingTab extends PluginSettingTab {
	plugin: DispatchCompanion;

	constructor(app: App, plugin: DispatchCompanion) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Blog folder")
			.setDesc("Vault folder that Dispatch scans for publishable posts")
			.addText((text) =>
				text
					.setPlaceholder("blog")
					.setValue(this.plugin.settings.blogFolder)
					.onChange(async (value) => {
						this.plugin.settings.blogFolder = value || "blog";
						await this.plugin.saveSettings();
						this.plugin.updateStatusBar();
					})
			);

		new Setting(containerEl)
			.setName("Default visibility")
			.setDesc("Visibility for new posts created via 'New blog post' command")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("public", "Public")
					.addOption("unlisted", "Unlisted")
					.setValue(this.plugin.settings.defaultVisibility)
					.onChange(async (value) => {
						this.plugin.settings.defaultVisibility = value as
							| "public"
							| "unlisted";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Website repo path")
			.setDesc(
				"Path to website2 git repo (optional, for future publish status checks)"
			)
			.addText((text) =>
				text
					.setPlaceholder("/Users/ejfox/code/website2")
					.setValue(this.plugin.settings.websiteRepo)
					.onChange(async (value) => {
						this.plugin.settings.websiteRepo = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
