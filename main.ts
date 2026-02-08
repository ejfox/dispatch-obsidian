import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	Notice,
	Modal,
	MarkdownView,
	moment,
	setIcon,
	debounce,
} from "obsidian";

// ── Interfaces ─────────────────────────────────────────────────────

interface DispatchSettings {
	blogFolder: string;
	defaultVisibility: "public" | "unlisted";
	dateFormat: string;
	showStatusBar: boolean;
	statusBarFormat: "counts" | "words" | "both";
	autoRemoveDraftField: boolean;
	showFileIcons: boolean;
	wordCountGoal: number;
	defaultTags: string[];
	customFrontmatter: string;
	ribbonIcon: boolean;
	notifyOnWarnings: boolean;
	websiteBaseUrl: string;
}

const DEFAULT_SETTINGS: DispatchSettings = {
	blogFolder: "blog",
	defaultVisibility: "public",
	dateFormat: "YYYY-MM-DDTHH:mm:ssZ",
	showStatusBar: true,
	statusBarFormat: "both",
	autoRemoveDraftField: true,
	showFileIcons: true,
	wordCountGoal: 0,
	defaultTags: [],
	customFrontmatter: "",
	ribbonIcon: true,
	notifyOnWarnings: true,
	websiteBaseUrl: "https://ejfox.com/blog",
};

interface DispatchStatusFile {
	path: string;
	slug: string;
	title: string | null;
	published_url: string | null;
	warnings: string[];
	word_count: number;
	is_safe: boolean;
	unlisted: boolean;
	has_password: boolean;
	modified: number;
}

interface DispatchStatus {
	updated_at: string;
	files: DispatchStatusFile[];
	stats: {
		total: number;
		drafts: number;
		published: number;
		total_words: number;
	};
}

interface DispatchQueue {
	updated_at: string;
	ready: string[];
	notes: Record<string, string>;
}

// ── Main Plugin ─────────────────────────────────────────────────────

export default class DispatchCompanion extends Plugin {
	settings: DispatchSettings = DEFAULT_SETTINGS;
	statusBarEl: HTMLElement | null = null;
	ribbonIconEl: HTMLElement | null = null;
	dispatchStatus: DispatchStatus | null = null;
	dispatchQueue: DispatchQueue | null = null;
	statusPollInterval: number | null = null;
	dailyWordCountCache: number = 0;
	dailyWordCountDate: string = "";

	async onload() {
		await this.loadSettings();
		await this.loadDispatchStatus();
		await this.loadDispatchQueue();

		// ── Status bar ──────────────────────────────────────────
		if (this.settings.showStatusBar) {
			this.statusBarEl = this.addStatusBarItem();
			this.statusBarEl.addClass("dispatch-status-bar");
			this.statusBarEl.addEventListener("click", () => {
				this.openDispatchPanel();
			});
			this.updateStatusBar();
		}

		// ── Ribbon icon ─────────────────────────────────────────
		if (this.settings.ribbonIcon) {
			this.ribbonIconEl = this.addRibbonIcon(
				"send",
				"Dispatch Companion",
				() => this.openDispatchPanel()
			);
		}

		// ── Event listeners ─────────────────────────────────────
		const debouncedStatusUpdate = debounce(
			() => this.updateStatusBar(),
			1000,
			true
		);
		this.registerEvent(
			this.app.vault.on("modify", debouncedStatusUpdate)
		);
		this.registerEvent(
			this.app.vault.on("create", debouncedStatusUpdate)
		);
		this.registerEvent(
			this.app.vault.on("delete", debouncedStatusUpdate)
		);

		// Auto-remove draft: true and warn on file open
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) this.onFileOpen(file);
			})
		);

		// File explorer context menu
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile)) return;
				if (!this.isBlogFile(file)) return;

				menu.addSeparator();

				menu.addItem((item) => {
					item.setTitle("Open in Dispatch")
						.setIcon("external-link")
						.onClick(() => {
							const slug = file.basename;
							new Notice(
								`Open Dispatch app and search for: ${slug}`
							);
						});
				});

				menu.addItem((item) => {
					item.setTitle("Toggle unlisted")
						.setIcon("eye-off")
						.onClick(() => this.toggleFrontmatter(file, "unlisted"));
				});

				menu.addItem((item) => {
					item.setTitle("Set password...")
						.setIcon("lock")
						.onClick(() => this.promptPassword(file));
				});

				menu.addItem((item) => {
					const isReady = this.isFileReady(file.path);
					item.setTitle(
						isReady
							? "Unmark ready to publish"
							: "Mark ready to publish"
					)
						.setIcon(isReady ? "x-circle" : "check-circle")
						.onClick(() => {
							if (isReady) {
								this.unmarkReady(file);
							} else {
								this.markReady(file);
							}
						});
				});

				menu.addItem((item) => {
					item.setTitle("Show publish status")
						.setIcon("info")
						.onClick(() => this.showPublishStatus(file));
				});
			})
		);

		// ── Poll Dispatch status.json ───────────────────────────
		this.statusPollInterval = window.setInterval(() => {
			this.loadDispatchStatus();
			this.updateStatusBar();
		}, 30000);
		this.registerInterval(this.statusPollInterval);

		// ── Commands ────────────────────────────────────────────

		this.addCommand({
			id: "new-blog-post",
			name: "New blog post",
			callback: () => this.openNewBlogPostModal(),
		});

		this.addCommand({
			id: "toggle-unlisted",
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

		this.addCommand({
			id: "mark-ready",
			name: "Mark ready to publish",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.isBlogFile(file)) return false;
				if (!checking) this.markReady(file);
				return true;
			},
		});

		this.addCommand({
			id: "unmark-ready",
			name: "Unmark ready to publish",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.isBlogFile(file)) return false;
				if (!checking) this.unmarkReady(file);
				return true;
			},
		});

		this.addCommand({
			id: "open-dispatch-panel",
			name: "Open Dispatch panel",
			callback: () => this.openDispatchPanel(),
		});

		this.addCommand({
			id: "copy-published-url",
			name: "Copy published URL",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.isBlogFile(file)) return false;
				if (!checking) this.copyPublishedUrl(file);
				return true;
			},
		});

		this.addCommand({
			id: "insert-date",
			name: "Insert today's date in frontmatter format",
			callback: () => {
				const view =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) {
					new Notice("No active editor");
					return;
				}
				const dateStr = moment().format(this.settings.dateFormat);
				view.editor.replaceSelection(dateStr);
			},
		});

		// ── Settings tab ────────────────────────────────────────
		this.addSettingTab(new DispatchSettingTab(this.app, this));
	}

	onunload() {
		// Intervals registered via registerInterval are auto-cleared
	}

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

	// ── Dispatch Interop ────────────────────────────────────────────

	async loadDispatchStatus() {
		try {
			const statusPath = ".dispatch/status.json";
			const file =
				this.app.vault.getAbstractFileByPath(statusPath);
			if (file && file instanceof TFile) {
				const content = await this.app.vault.read(file);
				this.dispatchStatus = JSON.parse(content) as DispatchStatus;
			}
		} catch {
			// status.json may not exist yet, that's fine
			this.dispatchStatus = null;
		}
	}

	async loadDispatchQueue() {
		try {
			const queuePath = ".dispatch/queue.json";
			const file =
				this.app.vault.getAbstractFileByPath(queuePath);
			if (file && file instanceof TFile) {
				const content = await this.app.vault.read(file);
				this.dispatchQueue = JSON.parse(content) as DispatchQueue;
			} else {
				this.dispatchQueue = {
					updated_at: new Date().toISOString(),
					ready: [],
					notes: {},
				};
			}
		} catch {
			this.dispatchQueue = {
				updated_at: new Date().toISOString(),
				ready: [],
				notes: {},
			};
		}
	}

	async saveDispatchQueue() {
		if (!this.dispatchQueue) return;
		this.dispatchQueue.updated_at = new Date().toISOString();
		const queuePath = ".dispatch/queue.json";
		const content = JSON.stringify(this.dispatchQueue, null, 2);

		// Ensure .dispatch folder exists
		const folder =
			this.app.vault.getAbstractFileByPath(".dispatch");
		if (!folder) {
			await this.app.vault.createFolder(".dispatch");
		}

		const file = this.app.vault.getAbstractFileByPath(queuePath);
		if (file && file instanceof TFile) {
			await this.app.vault.modify(file, content);
		} else {
			await this.app.vault.create(queuePath, content);
		}
	}

	isFileReady(path: string): boolean {
		return this.dispatchQueue?.ready?.includes(path) ?? false;
	}

	getDispatchFileInfo(path: string): DispatchStatusFile | null {
		if (!this.dispatchStatus) return null;
		return (
			this.dispatchStatus.files.find((f) => f.path === path) ?? null
		);
	}

	isDispatchFresh(): boolean {
		if (!this.dispatchStatus) return false;
		const updatedAt = new Date(this.dispatchStatus.updated_at).getTime();
		const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
		return updatedAt > fiveMinutesAgo;
	}

	// ── Status Bar ──────────────────────────────────────────────────

	updateStatusBar() {
		if (!this.statusBarEl || !this.settings.showStatusBar) return;

		const blogFolder = this.settings.blogFolder;
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(blogFolder + "/"));

		const total = files.length;
		if (total === 0) {
			this.statusBarEl.setText("");
			return;
		}

		let drafts: number;
		let published: number;
		let totalWords: number;

		// Prefer Dispatch status if available
		if (this.dispatchStatus && this.isDispatchFresh()) {
			drafts = this.dispatchStatus.stats.drafts;
			published = this.dispatchStatus.stats.published;
			totalWords = this.dispatchStatus.stats.total_words;
		} else {
			published = 0;
			drafts = 0;
			totalWords = 0;
			for (const file of files) {
				const cache = this.app.metadataCache.getFileCache(file);
				const fm = cache?.frontmatter;
				if (fm?.["published_url"]) {
					published++;
				} else {
					drafts++;
				}
			}
		}

		const todayWords = this.getDailyWordCount();
		const prefix = this.isDispatchFresh() ? "\u26A1 " : "";
		let text = "";

		switch (this.settings.statusBarFormat) {
			case "counts":
				text = `${prefix}${drafts} drafts \u00B7 ${published} live`;
				break;
			case "words":
				if (this.settings.wordCountGoal > 0) {
					text = `${prefix}${todayWords.toLocaleString()} / ${this.settings.wordCountGoal.toLocaleString()} words today`;
				} else {
					text = `${prefix}${todayWords.toLocaleString()} words today`;
				}
				break;
			case "both":
				text = `${prefix}${drafts} drafts \u00B7 ${todayWords.toLocaleString()}w today`;
				break;
		}

		this.statusBarEl.setText(text);

		// Tooltip
		const tooltipLines = [
			`Dispatch: ${drafts} drafts, ${published} published`,
			`Total files: ${total}`,
		];
		if (this.dispatchStatus) {
			tooltipLines.push(
				`Last scan: ${new Date(this.dispatchStatus.updated_at).toLocaleString()}`
			);
			tooltipLines.push(
				`Total words: ${(totalWords || 0).toLocaleString()}`
			);
		}
		if (this.settings.wordCountGoal > 0) {
			tooltipLines.push(
				`Daily goal: ${todayWords.toLocaleString()} / ${this.settings.wordCountGoal.toLocaleString()}`
			);
		}
		this.statusBarEl.setAttribute("aria-label", tooltipLines.join("\n"));
	}

	getDailyWordCount(): number {
		const today = moment().format("YYYY-MM-DD");
		if (this.dailyWordCountDate === today) {
			return this.dailyWordCountCache;
		}

		const blogFolder = this.settings.blogFolder;
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(blogFolder + "/"));

		let wordCount = 0;
		const todayStart = moment().startOf("day").valueOf();
		const todayEnd = moment().endOf("day").valueOf();

		for (const file of files) {
			// Count words in files modified today
			if (file.stat.mtime >= todayStart && file.stat.mtime <= todayEnd) {
				const cache = this.app.metadataCache.getFileCache(file);
				if (cache?.sections) {
					for (const section of cache.sections) {
						if (
							section.type === "paragraph" ||
							section.type === "heading"
						) {
							// Approximate word count from section positions
							const lineCount =
								section.position.end.line -
								section.position.start.line +
								1;
							wordCount += lineCount * 10; // rough estimate
						}
					}
				}
			}
		}

		// If dispatch status has per-file word counts, use those for files modified today
		if (this.dispatchStatus) {
			wordCount = 0;
			for (const sf of this.dispatchStatus.files) {
				const vaultFile = this.app.vault.getAbstractFileByPath(sf.path);
				if (
					vaultFile instanceof TFile &&
					vaultFile.stat.mtime >= todayStart &&
					vaultFile.stat.mtime <= todayEnd
				) {
					wordCount += sf.word_count;
				}
			}
		}

		this.dailyWordCountCache = wordCount;
		this.dailyWordCountDate = today;
		return wordCount;
	}

	// ── File Open Handler ───────────────────────────────────────────

	async onFileOpen(file: TFile) {
		if (!this.isBlogFile(file)) return;

		// Auto-remove draft: true
		if (this.settings.autoRemoveDraftField) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (cache?.frontmatter?.["draft"] === true) {
				await this.app.fileManager.processFrontMatter(file, (fm) => {
					if (fm["draft"] === true) {
						delete fm["draft"];
					}
				});
				new Notice(
					`Removed legacy draft: true from ${file.name}`
				);
			}
		}

		// Warn on Dispatch warnings
		if (this.settings.notifyOnWarnings && this.dispatchStatus) {
			const info = this.getDispatchFileInfo(file.path);
			if (info && info.warnings.length > 0) {
				const warningText = info.warnings
					.map((w) => `\u2022 ${w}`)
					.join("\n");
				new Notice(
					`Dispatch warnings for ${file.name}:\n${warningText}`,
					10000
				);
			}
		}
	}

	// ── Helpers ─────────────────────────────────────────────────────

	isBlogFile(file: TFile): boolean {
		return file.path.startsWith(this.settings.blogFolder + "/");
	}

	slugify(title: string): string {
		return title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "");
	}

	// ── New Blog Post Modal ─────────────────────────────────────────

	openNewBlogPostModal() {
		new NewBlogPostModal(this.app, this).open();
	}

	async createBlogPostFromModal(opts: {
		title: string;
		slug: string;
		visibility: "public" | "unlisted" | "protected";
		password: string;
		tags: string[];
	}) {
		const year = moment().format("YYYY");
		const date = moment().format(this.settings.dateFormat);
		const folderPath = `${this.settings.blogFolder}/${year}`;
		const filePath = `${folderPath}/${opts.slug}.md`;

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

		// Build frontmatter lines
		const fmLines: string[] = [];
		fmLines.push(`date: ${date}`);

		if (opts.tags.length > 0) {
			fmLines.push(`tags: [${opts.tags.map((t) => `"${t.trim()}"`).join(", ")}]`);
		} else {
			fmLines.push("tags: []");
		}

		if (
			opts.visibility === "unlisted" ||
			opts.visibility === "protected"
		) {
			fmLines.push("unlisted: true");
		}

		if (opts.visibility === "protected" && opts.password) {
			fmLines.push(`password: "${opts.password}"`);
		}

		// Custom frontmatter
		if (this.settings.customFrontmatter.trim()) {
			const customLines = this.settings.customFrontmatter
				.split("\n")
				.filter((l) => l.trim());
			fmLines.push(...customLines);
		}

		const content = `---\n${fmLines.join("\n")}\n---\n\n# ${opts.title}\n\n`;

		const file = await this.app.vault.create(filePath, content);
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);

		// Place cursor at end
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) {
			const editor = view.editor;
			editor.setCursor(editor.lastLine());
		}

		new Notice(`Created ${opts.slug}`);
	}

	// ── Frontmatter Helpers ─────────────────────────────────────────

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

	async promptPassword(file: TFile) {
		const modal = new PasswordModal(this.app, async (password) => {
			if (!password) return;
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				fm["password"] = password;
				fm["unlisted"] = true;
			});
			new Notice("Password set (implies unlisted)");
		});
		modal.open();
	}

	// ── Publish Status ──────────────────────────────────────────────

	async showPublishStatus(file: TFile) {
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		const dispatchInfo = this.getDispatchFileInfo(file.path);

		const lines: string[] = [];
		const slug = file.basename;

		// Published URL
		const publishedUrl =
			dispatchInfo?.published_url ?? fm?.["published_url"];
		if (publishedUrl) {
			lines.push(`Published: ${publishedUrl}`);
		} else {
			lines.push("Not published");
		}

		// Visibility
		if (fm?.["password"] || dispatchInfo?.has_password) {
			lines.push("Protected (password required)");
		} else if (fm?.["unlisted"] || dispatchInfo?.unlisted) {
			lines.push("Unlisted (link only)");
		} else {
			lines.push("Public (will appear in listings)");
		}

		// Safety
		if (dispatchInfo && !dispatchInfo.is_safe) {
			lines.push("Not safe to publish (Dispatch flagged issues)");
		}

		// Warnings from Dispatch
		if (dispatchInfo && dispatchInfo.warnings.length > 0) {
			lines.push("Warnings:");
			for (const w of dispatchInfo.warnings) {
				lines.push(`  \u2022 ${w}`);
			}
		}

		// Legacy draft
		if (fm?.["draft"]) {
			lines.push(
				"Has legacy draft: true (run 'Remove legacy draft: true' to clean up)"
			);
		}

		// Missing date
		if (!fm?.["date"]) {
			lines.push("Missing date (Dispatch will warn)");
		}

		// Word count
		if (dispatchInfo) {
			lines.push(`Word count: ${dispatchInfo.word_count.toLocaleString()}`);
		}

		// Ready to publish
		if (this.isFileReady(file.path)) {
			lines.push("Marked ready to publish");
		}

		new Notice(lines.join("\n"), 10000);
	}

	// ── Copy Published URL ──────────────────────────────────────────

	async copyPublishedUrl(file: TFile) {
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		const dispatchInfo = this.getDispatchFileInfo(file.path);

		const publishedUrl =
			dispatchInfo?.published_url ?? fm?.["published_url"];
		if (publishedUrl) {
			await navigator.clipboard.writeText(publishedUrl);
			new Notice(`Copied: ${publishedUrl}`);
		} else {
			// Generate preview URL from settings
			const slug = file.basename;
			const previewUrl = `${this.settings.websiteBaseUrl}/${slug}`;
			await navigator.clipboard.writeText(previewUrl);
			new Notice(`Copied preview URL (not yet published): ${previewUrl}`);
		}
	}

	// ── Publish Queue ───────────────────────────────────────────────

	async markReady(file: TFile, note?: string) {
		if (!this.dispatchQueue) {
			this.dispatchQueue = {
				updated_at: new Date().toISOString(),
				ready: [],
				notes: {},
			};
		}

		if (!this.dispatchQueue.ready.includes(file.path)) {
			this.dispatchQueue.ready.push(file.path);
		}
		if (note) {
			this.dispatchQueue.notes[file.path] = note;
		} else {
			this.dispatchQueue.notes[file.path] = "Ready for review";
		}

		await this.saveDispatchQueue();
		new Notice(`Marked ready to publish: ${file.name}`);
	}

	async unmarkReady(file: TFile) {
		if (!this.dispatchQueue) return;

		this.dispatchQueue.ready = this.dispatchQueue.ready.filter(
			(p) => p !== file.path
		);
		delete this.dispatchQueue.notes[file.path];

		await this.saveDispatchQueue();
		new Notice(`Unmarked: ${file.name}`);
	}

	// ── Dispatch Panel (Ribbon Modal) ───────────────────────────────

	openDispatchPanel() {
		new DispatchPanelModal(this.app, this).open();
	}
}

// ── New Blog Post Modal ─────────────────────────────────────────────

class NewBlogPostModal extends Modal {
	plugin: DispatchCompanion;
	titleInput: HTMLInputElement | null = null;
	slugInput: HTMLInputElement | null = null;
	visibility: "public" | "unlisted" | "protected" = "public";
	passwordInput: HTMLInputElement | null = null;
	passwordRow: HTMLElement | null = null;
	tagsInput: HTMLInputElement | null = null;

	constructor(app: App, plugin: DispatchCompanion) {
		super(app);
		this.plugin = plugin;
		this.visibility = plugin.settings.defaultVisibility as
			| "public"
			| "unlisted";
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("dispatch-new-post");
		contentEl.createEl("h2", { text: "New Blog Post" });

		// Title
		const titleGroup = contentEl.createDiv({
			cls: "dispatch-form-group",
		});
		titleGroup.createEl("label", { text: "Title" });
		this.titleInput = titleGroup.createEl("input", {
			type: "text",
			placeholder: "My new blog post",
			cls: "dispatch-input",
		});
		this.titleInput.focus();
		this.titleInput.addEventListener("input", () => {
			if (this.slugInput && this.titleInput) {
				this.slugInput.value = this.plugin.slugify(
					this.titleInput.value
				);
			}
		});

		// Slug preview
		const slugGroup = contentEl.createDiv({
			cls: "dispatch-form-group",
		});
		slugGroup.createEl("label", { text: "Slug" });
		this.slugInput = slugGroup.createEl("input", {
			type: "text",
			placeholder: "my-new-blog-post",
			cls: "dispatch-input dispatch-slug-input",
		});

		// Slug preview path
		const slugPreview = slugGroup.createEl("div", {
			cls: "dispatch-slug-preview",
		});
		const updateSlugPreview = () => {
			const slug = this.slugInput?.value || "...";
			const year = moment().format("YYYY");
			slugPreview.setText(
				`${this.plugin.settings.blogFolder}/${year}/${slug}.md`
			);
		};
		this.slugInput.addEventListener("input", updateSlugPreview);
		this.titleInput.addEventListener("input", updateSlugPreview);
		updateSlugPreview();

		// Visibility
		const visGroup = contentEl.createDiv({
			cls: "dispatch-form-group",
		});
		visGroup.createEl("label", { text: "Visibility" });
		const radioContainer = visGroup.createDiv({
			cls: "dispatch-radio-group",
		});

		const visOptions: Array<{
			value: "public" | "unlisted" | "protected";
			label: string;
			desc: string;
		}> = [
			{
				value: "public",
				label: "Public",
				desc: "Appears in listings and RSS",
			},
			{
				value: "unlisted",
				label: "Unlisted",
				desc: "Accessible only by direct link",
			},
			{
				value: "protected",
				label: "Protected",
				desc: "Requires a password to read",
			},
		];

		for (const opt of visOptions) {
			const radioLabel = radioContainer.createEl("label", {
				cls: "dispatch-radio-label",
			});
			const radio = radioLabel.createEl("input", {
				type: "radio",
				attr: { name: "visibility", value: opt.value },
			});
			if (opt.value === this.visibility) {
				radio.checked = true;
			}
			radio.addEventListener("change", () => {
				this.visibility = opt.value;
				if (this.passwordRow) {
					this.passwordRow.style.display =
						opt.value === "protected" ? "block" : "none";
				}
			});
			const labelText = radioLabel.createSpan({
				cls: "dispatch-radio-text",
			});
			labelText.createEl("strong", { text: opt.label });
			labelText.createEl("span", {
				text: ` \u2014 ${opt.desc}`,
				cls: "dispatch-radio-desc",
			});
		}

		// Password (conditional)
		this.passwordRow = contentEl.createDiv({
			cls: "dispatch-form-group",
		});
		this.passwordRow.style.display = "none";
		this.passwordRow.createEl("label", { text: "Password" });
		this.passwordInput = this.passwordRow.createEl("input", {
			type: "text",
			placeholder: "Enter password",
			cls: "dispatch-input",
		});

		// Tags
		const tagsGroup = contentEl.createDiv({
			cls: "dispatch-form-group",
		});
		tagsGroup.createEl("label", { text: "Tags" });
		this.tagsInput = tagsGroup.createEl("input", {
			type: "text",
			placeholder: "tag1, tag2, tag3",
			cls: "dispatch-input",
		});
		if (this.plugin.settings.defaultTags.length > 0) {
			this.tagsInput.value =
				this.plugin.settings.defaultTags.join(", ");
		}

		// Create button
		const btnGroup = contentEl.createDiv({
			cls: "dispatch-form-actions",
		});
		const createBtn = btnGroup.createEl("button", {
			text: "Create & Open",
			cls: "dispatch-btn-primary",
		});
		createBtn.addEventListener("click", () => this.submit());

		// Enter key submits
		contentEl.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.submit();
			}
		});
	}

	async submit() {
		const title = this.titleInput?.value?.trim();
		if (!title) {
			new Notice("Title is required");
			return;
		}

		const slug =
			this.slugInput?.value?.trim() || this.plugin.slugify(title);
		const tags = (this.tagsInput?.value || "")
			.split(",")
			.map((t) => t.trim())
			.filter((t) => t.length > 0);

		await this.plugin.createBlogPostFromModal({
			title,
			slug,
			visibility: this.visibility,
			password: this.passwordInput?.value?.trim() || "",
			tags,
		});

		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ── Password Modal ──────────────────────────────────────────────────

class PasswordModal extends Modal {
	callback: (password: string | null) => void;

	constructor(app: App, callback: (password: string | null) => void) {
		super(app);
		this.callback = callback;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Set password" });

		const input = contentEl.createEl("input", {
			type: "text",
			placeholder: "Enter password",
			cls: "dispatch-input",
		});
		input.style.width = "100%";
		input.focus();

		input.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter") {
				this.callback(input.value || null);
				this.close();
			}
			if (e.key === "Escape") {
				this.callback(null);
				this.close();
			}
		});

		const btnGroup = contentEl.createDiv({
			cls: "dispatch-form-actions",
		});
		const setBtn = btnGroup.createEl("button", {
			text: "Set Password",
			cls: "dispatch-btn-primary",
		});
		setBtn.addEventListener("click", () => {
			this.callback(input.value || null);
			this.close();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ── Dispatch Panel Modal ────────────────────────────────────────────

class DispatchPanelModal extends Modal {
	plugin: DispatchCompanion;

	constructor(app: App, plugin: DispatchCompanion) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("dispatch-modal");
		contentEl.createEl("h2", { text: "Dispatch" });

		// ── Stats section ───────────────────────────────────────
		const statsSection = contentEl.createDiv({
			cls: "dispatch-panel-section",
		});
		statsSection.createEl("h3", { text: "Overview" });

		const blogFolder = this.plugin.settings.blogFolder;
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(blogFolder + "/"));

		let drafts: number;
		let published: number;
		let totalWords: number;

		if (
			this.plugin.dispatchStatus &&
			this.plugin.isDispatchFresh()
		) {
			drafts = this.plugin.dispatchStatus.stats.drafts;
			published = this.plugin.dispatchStatus.stats.published;
			totalWords = this.plugin.dispatchStatus.stats.total_words;
		} else {
			published = 0;
			drafts = 0;
			totalWords = 0;
			for (const file of files) {
				const cache =
					this.app.metadataCache.getFileCache(file);
				const fm = cache?.frontmatter;
				if (fm?.["published_url"]) {
					published++;
				} else {
					drafts++;
				}
			}
		}

		const statsGrid = statsSection.createDiv({
			cls: "dispatch-stats-grid",
		});

		this.createStatCard(statsGrid, String(drafts), "Drafts");
		this.createStatCard(statsGrid, String(published), "Published");
		this.createStatCard(
			statsGrid,
			totalWords > 0 ? totalWords.toLocaleString() : "\u2014",
			"Total Words"
		);

		// Dispatch sync indicator
		if (this.plugin.dispatchStatus) {
			const syncInfo = statsSection.createDiv({
				cls: "dispatch-sync-info",
			});
			const isFresh = this.plugin.isDispatchFresh();
			const updatedAt = new Date(
				this.plugin.dispatchStatus.updated_at
			).toLocaleString();
			syncInfo.createEl("span", {
				text: isFresh
					? `\u26A1 Synced with Dispatch (${updatedAt})`
					: `Last scan: ${updatedAt} (stale)`,
				cls: isFresh
					? "dispatch-sync-fresh"
					: "dispatch-sync-stale",
			});
		} else {
			const syncInfo = statsSection.createDiv({
				cls: "dispatch-sync-info",
			});
			syncInfo.createEl("span", {
				text: "Dispatch app not detected (no .dispatch/status.json)",
				cls: "dispatch-sync-stale",
			});
		}

		// ── Word count goal ─────────────────────────────────────
		if (this.plugin.settings.wordCountGoal > 0) {
			const goalSection = contentEl.createDiv({
				cls: "dispatch-panel-section",
			});
			goalSection.createEl("h3", { text: "Daily Goal" });

			const todayWords = this.plugin.getDailyWordCount();
			const goal = this.plugin.settings.wordCountGoal;
			const pct = Math.min(100, Math.round((todayWords / goal) * 100));

			const goalBar = goalSection.createDiv({
				cls: "dispatch-goal-container",
			});
			const progressBar = goalBar.createDiv({
				cls: "dispatch-goal-bar",
			});
			const fill = progressBar.createDiv({
				cls: "dispatch-goal-fill",
			});
			fill.style.width = `${pct}%`;
			if (pct >= 100) fill.addClass("dispatch-goal-complete");

			goalBar.createDiv({
				cls: "dispatch-goal-text",
				text: `${todayWords.toLocaleString()} / ${goal.toLocaleString()} words (${pct}%)`,
			});
		}

		// ── Warnings ────────────────────────────────────────────
		if (this.plugin.dispatchStatus) {
			const filesWithWarnings =
				this.plugin.dispatchStatus.files.filter(
					(f) => f.warnings.length > 0
				);

			if (filesWithWarnings.length > 0) {
				const warnSection = contentEl.createDiv({
					cls: "dispatch-panel-section",
				});
				warnSection.createEl("h3", {
					text: `Warnings (${filesWithWarnings.length})`,
				});

				const warnList = warnSection.createEl("ul", {
					cls: "dispatch-warning-list",
				});
				for (const f of filesWithWarnings) {
					const item = warnList.createEl("li");
					item.createEl("strong", {
						text: f.title || f.slug,
					});
					const subList = item.createEl("ul");
					for (const w of f.warnings) {
						subList.createEl("li", {
							text: w,
							cls: "dispatch-warning-item",
						});
					}
				}
			}
		}

		// ── Ready to publish ────────────────────────────────────
		if (
			this.plugin.dispatchQueue &&
			this.plugin.dispatchQueue.ready.length > 0
		) {
			const readySection = contentEl.createDiv({
				cls: "dispatch-panel-section",
			});
			readySection.createEl("h3", {
				text: `Ready to Publish (${this.plugin.dispatchQueue.ready.length})`,
			});

			const readyList = readySection.createEl("ul", {
				cls: "dispatch-ready-list",
			});
			for (const path of this.plugin.dispatchQueue.ready) {
				const item = readyList.createEl("li");
				const link = item.createEl("a", {
					text: path,
					cls: "dispatch-file-link",
					href: "#",
				});
				link.addEventListener("click", async (e) => {
					e.preventDefault();
					const file =
						this.app.vault.getAbstractFileByPath(path);
					if (file instanceof TFile) {
						await this.app.workspace
							.getLeaf(false)
							.openFile(file);
						this.close();
					}
				});

				const note =
					this.plugin.dispatchQueue?.notes[path];
				if (note) {
					item.createEl("span", {
						text: ` \u2014 ${note}`,
						cls: "dispatch-ready-note",
					});
				}

				const unmarkBtn = item.createEl("button", {
					text: "\u00D7",
					cls: "dispatch-unmark-btn",
					attr: { "aria-label": "Unmark ready" },
				});
				unmarkBtn.addEventListener("click", async () => {
					const f =
						this.app.vault.getAbstractFileByPath(path);
					if (f instanceof TFile) {
						await this.plugin.unmarkReady(f);
						this.close();
						this.plugin.openDispatchPanel();
					}
				});
			}
		}

		// ── Recent drafts ───────────────────────────────────────
		const draftsSection = contentEl.createDiv({
			cls: "dispatch-panel-section",
		});
		draftsSection.createEl("h3", { text: "Recent Drafts" });

		const draftFiles = files
			.filter((f) => {
				const cache = this.app.metadataCache.getFileCache(f);
				return !cache?.frontmatter?.["published_url"];
			})
			.sort((a, b) => b.stat.mtime - a.stat.mtime)
			.slice(0, 10);

		if (draftFiles.length === 0) {
			draftsSection.createEl("p", {
				text: "No drafts found",
				cls: "dispatch-muted",
			});
		} else {
			const draftList = draftsSection.createEl("ul", {
				cls: "dispatch-draft-list",
			});
			for (const file of draftFiles) {
				const item = draftList.createEl("li");
				const link = item.createEl("a", {
					text: file.basename,
					cls: "dispatch-file-link",
					href: "#",
				});
				link.addEventListener("click", async (e) => {
					e.preventDefault();
					await this.app.workspace
						.getLeaf(false)
						.openFile(file);
					this.close();
				});

				const modTime = moment(file.stat.mtime).fromNow();
				item.createEl("span", {
					text: ` \u2014 ${modTime}`,
					cls: "dispatch-muted",
				});

				// Show readiness
				if (this.plugin.isFileReady(file.path)) {
					item.createEl("span", {
						text: " [ready]",
						cls: "dispatch-ready-badge",
					});
				}
			}
		}
	}

	createStatCard(parent: HTMLElement, value: string, label: string) {
		const card = parent.createDiv({ cls: "dispatch-stat-card" });
		card.createDiv({ cls: "dispatch-stat-value", text: value });
		card.createDiv({ cls: "dispatch-stat-label", text: label });
	}

	onClose() {
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

		// ── General ─────────────────────────────────────────────
		containerEl.createEl("h3", { text: "General" });

		new Setting(containerEl)
			.setName("Blog folder")
			.setDesc(
				"Vault folder that Dispatch scans for publishable posts"
			)
			.addText((text) =>
				text
					.setPlaceholder("blog")
					.setValue(this.plugin.settings.blogFolder)
					.onChange(async (value) => {
						this.plugin.settings.blogFolder =
							value || "blog";
						await this.plugin.saveSettings();
						this.plugin.updateStatusBar();
					})
			);

		new Setting(containerEl)
			.setName("Website base URL")
			.setDesc(
				"Base URL for published blog posts (used for URL previews and copy)"
			)
			.addText((text) =>
				text
					.setPlaceholder("https://ejfox.com/blog")
					.setValue(this.plugin.settings.websiteBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.websiteBaseUrl = value;
						await this.plugin.saveSettings();
					})
			);

		// ── New Posts ────────────────────────────────────────────
		containerEl.createEl("h3", { text: "New Posts" });

		new Setting(containerEl)
			.setName("Default visibility")
			.setDesc(
				"Visibility for new posts created via 'New blog post' command"
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("public", "Public")
					.addOption("unlisted", "Unlisted")
					.setValue(this.plugin.settings.defaultVisibility)
					.onChange(async (value) => {
						this.plugin.settings.defaultVisibility =
							value as "public" | "unlisted";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Date format")
			.setDesc(
				"Moment.js format for dates in frontmatter (e.g. YYYY-MM-DDTHH:mm:ssZ)"
			)
			.addText((text) =>
				text
					.setPlaceholder("YYYY-MM-DDTHH:mm:ssZ")
					.setValue(this.plugin.settings.dateFormat)
					.onChange(async (value) => {
						this.plugin.settings.dateFormat =
							value || "YYYY-MM-DDTHH:mm:ssZ";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default tags")
			.setDesc(
				"Comma-separated tags to pre-fill when creating new posts"
			)
			.addText((text) =>
				text
					.setPlaceholder("blog, draft")
					.setValue(
						this.plugin.settings.defaultTags.join(", ")
					)
					.onChange(async (value) => {
						this.plugin.settings.defaultTags = value
							.split(",")
							.map((t) => t.trim())
							.filter((t) => t.length > 0);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Custom frontmatter")
			.setDesc(
				"Extra YAML lines to add to new posts (one per line, e.g. 'author: EJ Fox')"
			)
			.addTextArea((text) =>
				text
					.setPlaceholder("author: EJ Fox\nlayout: post")
					.setValue(this.plugin.settings.customFrontmatter)
					.onChange(async (value) => {
						this.plugin.settings.customFrontmatter = value;
						await this.plugin.saveSettings();
					})
			);

		// ── Display ─────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Display" });

		new Setting(containerEl)
			.setName("Show status bar")
			.setDesc("Display draft/published counts in the status bar")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showStatusBar)
					.onChange(async (value) => {
						this.plugin.settings.showStatusBar = value;
						await this.plugin.saveSettings();
						// Requires reload to add/remove status bar
						new Notice(
							"Restart Obsidian to apply status bar changes"
						);
					})
			);

		new Setting(containerEl)
			.setName("Status bar format")
			.setDesc("What to display in the status bar")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("counts", "Counts (3 drafts \u00B7 12 live)")
					.addOption("words", "Words (1,250 / 2,000 words today)")
					.addOption("both", "Both (3 drafts \u00B7 1,250w today)")
					.setValue(this.plugin.settings.statusBarFormat)
					.onChange(async (value) => {
						this.plugin.settings.statusBarFormat =
							value as "counts" | "words" | "both";
						await this.plugin.saveSettings();
						this.plugin.updateStatusBar();
					})
			);

		new Setting(containerEl)
			.setName("Show file icons")
			.setDesc(
				"Show publish status icons in file explorer (future feature)"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showFileIcons)
					.onChange(async (value) => {
						this.plugin.settings.showFileIcons = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Ribbon icon")
			.setDesc(
				"Show Dispatch icon in the left sidebar ribbon"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.ribbonIcon)
					.onChange(async (value) => {
						this.plugin.settings.ribbonIcon = value;
						await this.plugin.saveSettings();
						new Notice(
							"Restart Obsidian to apply ribbon icon changes"
						);
					})
			);

		// ── Behavior ────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Behavior" });

		new Setting(containerEl)
			.setName("Auto-remove draft: true")
			.setDesc(
				"Automatically remove legacy draft: true from blog files when opened"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(
						this.plugin.settings.autoRemoveDraftField
					)
					.onChange(async (value) => {
						this.plugin.settings.autoRemoveDraftField =
							value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Notify on warnings")
			.setDesc(
				"Show a notice when opening a blog file that has Dispatch warnings"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(
						this.plugin.settings.notifyOnWarnings
					)
					.onChange(async (value) => {
						this.plugin.settings.notifyOnWarnings =
							value;
						await this.plugin.saveSettings();
					})
			);

		// ── Goals ───────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Goals" });

		new Setting(containerEl)
			.setName("Daily word count goal")
			.setDesc(
				"Target words per day (0 to disable). Shown in status bar and Dispatch panel."
			)
			.addText((text) =>
				text
					.setPlaceholder("0")
					.setValue(
						String(this.plugin.settings.wordCountGoal)
					)
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						this.plugin.settings.wordCountGoal =
							isNaN(num) || num < 0 ? 0 : num;
						await this.plugin.saveSettings();
						this.plugin.updateStatusBar();
					})
			);
	}
}
