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
	// Joy features
	enableStreaks: boolean;           // track writing/publish streaks
	celebrateMilestones: boolean;    // notices at word count milestones
	showOnThisDay: boolean;          // "on this day" past publishes
	sessionWordCount: boolean;       // track words written this session
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
	enableStreaks: true,
	celebrateMilestones: true,
	showOnThisDay: true,
	sessionWordCount: true,
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
	last_publish: string | null; // slug of most recently published file
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

	// Joy state
	sessionStartWordCount: number = 0;
	sessionWordsWritten: number = 0;
	lastMilestoneCelebrated: number = 0;
	streakData: { dates: string[]; publishDates: string[] } = { dates: [], publishDates: [] };

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

		// ── Joy features ────────────────────────────────────────

		// Load streak data
		if (this.settings.enableStreaks) {
			await this.loadStreakData();
			this.recordWritingDay();
		}

		// Session word counter: snapshot current total on load
		if (this.settings.sessionWordCount) {
			this.sessionStartWordCount = this.getTotalBlogWords();
		}

		// Word count milestone celebrations
		if (this.settings.celebrateMilestones) {
			this.registerEvent(
				this.app.vault.on("modify", (file) => {
					if (file instanceof TFile && this.isBlogFile(file)) {
						this.checkSessionMilestones();
					}
				})
			);
		}

		// "On this day" check
		if (this.settings.showOnThisDay) {
			// Delay so it doesn't fire during startup noise
			window.setTimeout(() => this.checkOnThisDay(), 3000);
		}

		this.addCommand({
			id: "show-writing-streak",
			name: "Show writing streak",
			callback: () => this.showStreakNotice(),
		});

		this.addCommand({
			id: "on-this-day",
			name: "On this day...",
			callback: () => this.checkOnThisDay(),
		});

		this.addCommand({
			id: "session-stats",
			name: "Show session stats",
			callback: () => this.showSessionStats(),
		});

		this.addCommand({
			id: "random-draft",
			name: "Open a random draft",
			callback: () => this.openRandomDraft(),
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
				const newStatus = JSON.parse(content) as DispatchStatus;

				// Detect fresh publish and celebrate
				if (
					newStatus.last_publish &&
					this.settings.enableStreaks &&
					(!this.dispatchStatus || this.dispatchStatus.last_publish !== newStatus.last_publish)
				) {
					this.celebratePublish(newStatus.last_publish);
				}

				this.dispatchStatus = newStatus;
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
		const prefix = this.isDispatchFresh() ? "\u25CF " : "";
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

		// Record writing day for streak tracking
		if (this.settings.enableStreaks) {
			this.recordWritingDay();
		}
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

	// ── Joy: Streaks ───────────────────────────────────────────────

	async loadStreakData() {
		try {
			const data = await this.loadData();
			if (data?.streakData) {
				this.streakData = data.streakData;
			}
		} catch {
			// fresh start
		}
	}

	async saveStreakData() {
		const data = (await this.loadData()) || {};
		data.streakData = this.streakData;
		await this.saveData({ ...data, ...this.settings, streakData: this.streakData });
	}

	recordWritingDay() {
		const today = moment().format("YYYY-MM-DD");
		if (!this.streakData.dates.includes(today)) {
			this.streakData.dates.push(today);
			// Keep last 365 days
			if (this.streakData.dates.length > 365) {
				this.streakData.dates = this.streakData.dates.slice(-365);
			}
			this.saveStreakData();
		}
	}

	recordPublishDay() {
		const today = moment().format("YYYY-MM-DD");
		if (!this.streakData.publishDates.includes(today)) {
			this.streakData.publishDates.push(today);
			if (this.streakData.publishDates.length > 365) {
				this.streakData.publishDates = this.streakData.publishDates.slice(-365);
			}
			this.saveStreakData();
		}
	}

	getWritingStreak(): number {
		const dates = [...this.streakData.dates].sort().reverse();
		if (dates.length === 0) return 0;

		let streak = 0;
		let expected = moment();

		for (const dateStr of dates) {
			const date = moment(dateStr, "YYYY-MM-DD");
			if (date.isSame(expected, "day")) {
				streak++;
				expected = expected.subtract(1, "day");
			} else if (date.isBefore(expected, "day")) {
				break;
			}
		}
		return streak;
	}

	getPublishStreak(): number {
		const dates = [...this.streakData.publishDates].sort().reverse();
		if (dates.length === 0) return 0;

		// Publishing streak = consecutive days with publishes
		// More lenient: consecutive weeks
		let streak = 0;
		let expected = moment().startOf("week");

		const weekSet = new Set(dates.map(d => moment(d).startOf("week").format("YYYY-WW")));
		let currentWeek = moment().startOf("week");

		for (let i = 0; i < 52; i++) {
			if (weekSet.has(currentWeek.format("YYYY-WW"))) {
				streak++;
				currentWeek = currentWeek.subtract(1, "week");
			} else {
				break;
			}
		}
		return streak;
	}

	showStreakNotice() {
		const writingStreak = this.getWritingStreak();
		const publishStreak = this.getPublishStreak();
		const totalDays = this.streakData.dates.length;
		const totalPublishes = this.streakData.publishDates.length;

		const lines: string[] = [];

		if (writingStreak > 0) {
			lines.push(`Writing streak: ${writingStreak} day${writingStreak === 1 ? "" : "s"}`);
		} else {
			lines.push("Start a writing streak today.");
		}

		if (publishStreak > 0) {
			lines.push(`Publish streak: ${publishStreak} week${publishStreak === 1 ? "" : "s"}`);
		}

		lines.push(`${totalDays} writing days \u00B7 ${totalPublishes} publish days recorded`);

		// Mini contribution graph (last 7 days)
		const last7: string[] = [];
		for (let i = 6; i >= 0; i--) {
			const date = moment().subtract(i, "days").format("YYYY-MM-DD");
			last7.push(this.streakData.dates.includes(date) ? "\u2588" : "\u2591");
		}
		lines.push(`Last 7 days: ${last7.join("")}`);

		new Notice(lines.join("\n"), 10000);
	}

	// ── Joy: Session Word Counter ──────────────────────────────────

	getTotalBlogWords(): number {
		if (this.dispatchStatus) {
			return this.dispatchStatus.stats.total_words;
		}
		// Fallback: rough count from file sizes
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(this.settings.blogFolder + "/"));
		let total = 0;
		for (const file of files) {
			total += Math.round(file.stat.size / 5); // ~5 chars per word
		}
		return total;
	}

	checkSessionMilestones() {
		if (!this.settings.celebrateMilestones) return;

		const current = this.getTotalBlogWords();
		this.sessionWordsWritten = Math.max(0, current - this.sessionStartWordCount);

		const milestones = [100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000];
		for (const milestone of milestones) {
			if (
				this.sessionWordsWritten >= milestone &&
				this.lastMilestoneCelebrated < milestone
			) {
				this.lastMilestoneCelebrated = milestone;
				this.celebrateMilestone(milestone);
				break;
			}
		}
	}

	celebrateMilestone(words: number) {
		const celebrations: Record<number, string> = {
			100: "100 words this session \u2014 warming up.",
			250: "250 words \u2014 the ideas are flowing.",
			500: "500 words. Half a thousand. Keep going.",
			750: "750 words \u2014 you're in the zone.",
			1000: "1,000 words this session. That's an essay.",
			1500: "1,500 words \u2014 on fire.",
			2000: "2,000 words. A serious writing session.",
			3000: "3,000 words \u2014 prolific.",
			5000: "5,000 words in one session. Legendary.",
		};

		const message = celebrations[words] || `${words} words this session!`;
		new Notice(message, 6000);
	}

	showSessionStats() {
		const current = this.getTotalBlogWords();
		this.sessionWordsWritten = Math.max(0, current - this.sessionStartWordCount);

		const lines: string[] = [
			`Session: ${this.sessionWordsWritten.toLocaleString()} words written`,
		];

		if (this.settings.wordCountGoal > 0) {
			const dailyWords = this.getDailyWordCount();
			const pct = Math.round((dailyWords / this.settings.wordCountGoal) * 100);
			lines.push(`Daily goal: ${pct}% (${dailyWords.toLocaleString()} / ${this.settings.wordCountGoal.toLocaleString()})`);
		}

		const streak = this.getWritingStreak();
		if (streak > 0) {
			lines.push(`Writing streak: ${streak} day${streak === 1 ? "" : "s"}`);
		}

		new Notice(lines.join("\n"), 8000);
	}

	// ── Joy: On This Day ───────────────────────────────────────────

	checkOnThisDay() {
		const today = moment();
		const monthDay = today.format("MM-DD");

		const blogFolder = this.settings.blogFolder;
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(blogFolder + "/"));

		const matches: { file: TFile; year: string }[] = [];

		for (const file of files) {
			const cache = this.app.metadataCache.getFileCache(file);
			const fm = cache?.frontmatter;
			if (fm?.["date"] && fm?.["published_url"]) {
				const dateStr = String(fm["date"]);
				const pubMoment = moment(dateStr);
				if (
					pubMoment.isValid() &&
					pubMoment.format("MM-DD") === monthDay &&
					pubMoment.year() !== today.year()
				) {
					matches.push({
						file,
						year: pubMoment.format("YYYY"),
					});
				}
			}
		}

		if (matches.length === 0) {
			if (!this.settings.showOnThisDay) {
				// Only show "nothing" if manually triggered
				new Notice("No posts published on this day in previous years.");
			}
			return;
		}

		const lines = ["On this day\u2026"];
		for (const m of matches.sort((a, b) => a.year.localeCompare(b.year))) {
			const title = m.file.basename.replace(/-/g, " ");
			lines.push(`  ${m.year}: ${title}`);
		}

		new Notice(lines.join("\n"), 12000);
	}

	// ── Joy: Random Draft ──────────────────────────────────────────

	async openRandomDraft() {
		const blogFolder = this.settings.blogFolder;
		const drafts = this.app.vault
			.getMarkdownFiles()
			.filter((f) => {
				if (!f.path.startsWith(blogFolder + "/")) return false;
				const cache = this.app.metadataCache.getFileCache(f);
				return !cache?.frontmatter?.["published_url"];
			});

		if (drafts.length === 0) {
			new Notice("No drafts to choose from \u2014 everything's published!");
			return;
		}

		const pick = drafts[Math.floor(Math.random() * drafts.length)];
		await this.app.workspace.getLeaf(false).openFile(pick);

		const title = pick.basename.replace(/-/g, " ");
		const encouragements = [
			`How about finishing "${title}"?`,
			`"${title}" has been waiting for you.`,
			`Maybe today's the day for "${title}".`,
			`"${title}" \u2014 revisit this one?`,
			`This draft could be today's essay: "${title}"`,
		];
		new Notice(
			encouragements[Math.floor(Math.random() * encouragements.length)],
			6000
		);
	}

	// ── Joy: Publish Celebration ───────────────────────────────────

	celebratePublish(slug: string) {
		this.recordPublishDay();
		const publishStreak = this.getPublishStreak();

		const lines = [`Published: ${slug}`];

		if (publishStreak > 1) {
			lines.push(`Publishing streak: ${publishStreak} weeks in a row.`);
		}

		const totalPublishes = this.streakData.publishDates.length;
		if (totalPublishes % 10 === 0 && totalPublishes > 0) {
			lines.push(`That's publish #${totalPublishes}.`);
		}

		// Count remaining drafts for gentle pressure
		const blogFolder = this.settings.blogFolder;
		const remaining = this.app.vault
			.getMarkdownFiles()
			.filter((f) => {
				if (!f.path.startsWith(blogFolder + "/")) return false;
				const cache = this.app.metadataCache.getFileCache(f);
				return !cache?.frontmatter?.["published_url"];
			}).length;

		if (remaining === 0) {
			lines.push("Inbox zero \u2014 every draft is published.");
		} else if (remaining <= 3) {
			lines.push(`Almost there \u2014 only ${remaining} draft${remaining === 1 ? "" : "s"} left.`);
		}

		new Notice(lines.join("\n"), 8000);
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

		// Session words
		if (this.plugin.settings.sessionWordCount) {
			const sessionWords = Math.max(0, this.plugin.getTotalBlogWords() - this.plugin.sessionStartWordCount);
			this.createStatCard(statsGrid, sessionWords.toLocaleString(), "Session");
		}

		// ── Streak section ──────────────────────────────────────
		if (this.plugin.settings.enableStreaks) {
			const streakContainer = statsSection.createDiv({ cls: "dispatch-streak-container" });

			const writingStreak = this.plugin.getWritingStreak();
			const publishStreak = this.plugin.getPublishStreak();

			if (writingStreak > 0 || publishStreak > 0) {
				const streakLine = streakContainer.createDiv({ cls: "dispatch-streak-line" });
				if (writingStreak > 0) {
					streakLine.createSpan({ text: `${writingStreak}-day writing streak`, cls: "dispatch-streak-badge" });
				}
				if (publishStreak > 0) {
					streakLine.createSpan({ text: `${publishStreak}-week publish streak`, cls: "dispatch-streak-badge" });
				}
			}

			// Mini contribution graph (last 14 days)
			const graphRow = streakContainer.createDiv({ cls: "dispatch-streak-graph" });
			for (let i = 13; i >= 0; i--) {
				const date = moment().subtract(i, "days");
				const dateStr = date.format("YYYY-MM-DD");
				const wrote = this.plugin.streakData.dates.includes(dateStr);
				const published = this.plugin.streakData.publishDates.includes(dateStr);

				const cell = graphRow.createSpan({ cls: "dispatch-streak-cell" });
				if (published) {
					cell.addClass("dispatch-streak-published");
					cell.setAttribute("aria-label", `${date.format("MMM D")}: published`);
				} else if (wrote) {
					cell.addClass("dispatch-streak-wrote");
					cell.setAttribute("aria-label", `${date.format("MMM D")}: wrote`);
				} else {
					cell.addClass("dispatch-streak-empty");
					cell.setAttribute("aria-label", `${date.format("MMM D")}: -`);
				}
			}

			const graphLabel = streakContainer.createDiv({ cls: "dispatch-streak-label" });
			graphLabel.setText("Last 14 days");
		}

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
					? `Synced with Dispatch (${updatedAt})`
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

		// ── Quick actions ───────────────────────────────────────
		const actionsSection = contentEl.createDiv({ cls: "dispatch-panel-section" });
		actionsSection.createEl("h3", { text: "Quick Actions" });
		const actionsRow = actionsSection.createDiv({ cls: "dispatch-actions-row" });

		const newPostBtn = actionsRow.createEl("button", { text: "New Post", cls: "dispatch-action-btn" });
		newPostBtn.addEventListener("click", () => {
			this.close();
			this.plugin.openNewBlogPostModal();
		});

		const randomBtn = actionsRow.createEl("button", { text: "Random Draft", cls: "dispatch-action-btn" });
		randomBtn.addEventListener("click", () => {
			this.close();
			this.plugin.openRandomDraft();
		});

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

		// ── Joy & Motivation ────────────────────────────────────
		containerEl.createEl("h3", { text: "Joy & Motivation" });

		new Setting(containerEl)
			.setName("Writing streaks")
			.setDesc("Track consecutive days of writing and weeks of publishing")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableStreaks)
					.onChange(async (value) => {
						this.plugin.settings.enableStreaks = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Milestone celebrations")
			.setDesc("Celebrate when you hit word count milestones during a session (100, 500, 1000...)")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.celebrateMilestones)
					.onChange(async (value) => {
						this.plugin.settings.celebrateMilestones = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("On this day")
			.setDesc("Show posts you published on today's date in previous years")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showOnThisDay)
					.onChange(async (value) => {
						this.plugin.settings.showOnThisDay = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Session word counter")
			.setDesc("Track words written in the current Obsidian session")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.sessionWordCount)
					.onChange(async (value) => {
						this.plugin.settings.sessionWordCount = value;
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
