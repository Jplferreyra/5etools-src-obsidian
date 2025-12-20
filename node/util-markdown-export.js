import fs from "fs";
import path from "path";
import crypto from "crypto";
import {readJson, listFiles} from "./util.js";
import "../js/parser.js";
import "../js/utils.js";
import "../js/utils-config.js";
import "../js/render.js";
import "../js/render-markdown.js";
import "../js/render-feats.js";

/**
 * Obsidian-specific markdown renderer that extends RendererMarkdown
 * to convert 5etools tags to Obsidian wikilinks
 */
class ObsidianMarkdownRenderer extends RendererMarkdown {
	constructor() {
		super();
		this._wikilinksEnabled = true;
	}

	static TAG_TO_DIR_MAP = {
		"@spell": "spells",
		"@item": "items",
		"@creature": "monsters",
		"@monster": "monsters",
		"@background": "backgrounds",
		"@class": "classes",
		"@subclass": "subclasses",
		"@race": "races",
		"@feat": "feats",
		"@condition": "conditions",
		"@disease": "conditions",
		"@deity": "deities",
		"@action": "actions",
		"@vehicle": "vehicles",
		"@object": "objects",
		"@optionalfeature": "optional-features",
		"@reward": "rewards",
		"@psionic": "psionics",
		"@variantrule": "variant-rules",
		"@table": "tables",
		"@language": "languages",
		"@trap": "traps-hazards",
		"@hazard": "traps-hazards",
		"@cult": "cults-boons",
		"@boon": "cults-boons",
	};

	/**
	 * Override the tag rendering to convert cross-references to Obsidian wikilinks
	 */
	_renderString_renderTag(textStack, meta, options, tag, text) {
		if (!this._wikilinksEnabled || !ObsidianMarkdownRenderer.TAG_TO_DIR_MAP[tag]) {
			// Fall back to parent implementation for non-ref tags
			return super._renderString_renderTag(textStack, meta, options, tag, text);
		}

		// Parse the tag text (format: "name|source|displayText")
		const parts = Renderer.splitTagByPipe(text);
		const name = parts[0];
		const source = parts[1] || "PHB";
		const displayText = parts[2] || name;

		// Get the resource directory
		const resourceDir = ObsidianMarkdownRenderer.TAG_TO_DIR_MAP[tag];

		// Clean the name for use in filename
		const cleanName = this._cleanName(name);
		const cleanSource = source.toUpperCase();

		// Generate wikilink: [[resourceDir/Name (SOURCE)|Display Text]]
		const wikilink = displayText === name
			? `[[${resourceDir}/${cleanName} (${cleanSource})]]`
			: `[[${resourceDir}/${cleanName} (${cleanSource})|${displayText}]]`;

		textStack[0] += wikilink;
	}

	/**
	 * Clean entity name for use in filename
	 * Removes HTML tags and trims whitespace
	 */
	_cleanName(name) {
		return Renderer.stripTags(name).trim();
	}

	/**
	 * Factory method to create a configured instance
	 */
	static get() {
		return new ObsidianMarkdownRenderer()
			.setFnPostProcess(RendererMarkdown._fnPostProcess);
	}
}

/**
 * Tracks export state for incremental updates
 */
class ExportStateTracker {
	constructor(statePath = ".markdown-export-state.json") {
		this.statePath = statePath;
		this.state = null;
	}

	/**
	 * Load the export state from disk
	 */
	async loadState() {
		if (this.state) return this.state;

		try {
			if (fs.existsSync(this.statePath)) {
				const data = fs.readFileSync(this.statePath, "utf8");
				this.state = JSON.parse(data);
			} else {
				this.state = this._createEmptyState();
			}
		} catch (e) {
			console.warn(`Failed to load state from ${this.statePath}, starting fresh:`, e.message);
			this.state = this._createEmptyState();
		}

		return this.state;
	}

	/**
	 * Save the export state to disk
	 */
	async saveState() {
		if (!this.state) return;

		try {
			this.state.last_export = new Date().toISOString();
			fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
		} catch (e) {
			console.error(`Failed to save state to ${this.statePath}:`, e.message);
			throw e;
		}
	}

	/**
	 * Detect changes in a source file
	 * Returns { changed: boolean, entries: [...changedEntries] }
	 */
	async detectChanges(sourceFile) {
		await this.loadState();

		// Check if file exists
		if (!fs.existsSync(sourceFile)) {
			console.warn(`Source file not found: ${sourceFile}`);
			return {changed: false, entries: []};
		}

		// Read file and compute hash
		const fileContent = fs.readFileSync(sourceFile, "utf8");
		const fileHash = this._computeHash(fileContent);

		// Quick check: file unchanged
		const prevFileHash = this.state.files[sourceFile]?.hash;
		if (prevFileHash === fileHash) {
			return {changed: false, entries: []};
		}

		// File changed - check individual entries
		let data;
		try {
			data = JSON.parse(fileContent);
		} catch (e) {
			console.error(`Failed to parse JSON in ${sourceFile}:`, e.message);
			return {changed: false, entries: []};
		}

		const changedEntries = [];

		// Process each resource type in the file
		for (const [entryType, entries] of Object.entries(data)) {
			if (entryType === "_meta") continue;
			if (!Array.isArray(entries)) continue;

			for (const entry of entries) {
				const entryKey = this._getEntryKey(entryType, entry);
				const entryHash = this._computeHash(JSON.stringify(entry));

				const prevEntryHash = this.state.files[sourceFile]?.entries?.[entryKey]?.entry_hash;

				if (prevEntryHash !== entryHash) {
					changedEntries.push({
						entryType,
						entry,
						entryKey,
						entryHash,
						reason: prevEntryHash ? "modified" : "new",
					});
				}
			}
		}

		return {
			changed: true,
			fileHash,
			entries: changedEntries,
		};
	}

	/**
	 * Update state after exporting an entry
	 */
	updateEntryState(sourceFile, fileHash, entryKey, entryHash, outputFile) {
		if (!this.state.files[sourceFile]) {
			this.state.files[sourceFile] = {
				hash: fileHash,
				entries: {},
			};
		}

		this.state.files[sourceFile].hash = fileHash;
		this.state.files[sourceFile].entries[entryKey] = {
			entry_hash: entryHash,
			output_file: outputFile,
			exported_at: new Date().toISOString(),
		};

		// Update index
		if (!this.state.index) this.state.index = {};
		this.state.index[entryKey] = {
			source_file: sourceFile,
			output_file: outputFile,
		};
	}

	/**
	 * Generate a unique key for an entry
	 * Format: "type|name|source"
	 */
	_getEntryKey(entryType, entry) {
		const name = (entry.name || "unknown").toLowerCase();
		const source = (entry.source || "unknown").toLowerCase();
		return `${entryType}|${name}|${source}`;
	}

	/**
	 * Compute SHA-256 hash of data
	 */
	_computeHash(data) {
		return crypto.createHash("sha256").update(data).digest("hex");
	}

	/**
	 * Create an empty state structure
	 */
	_createEmptyState() {
		return {
			version: "1.0.0",
			last_export: null,
			files: {},
			index: {},
		};
	}
}

/**
 * Generates YAML frontmatter for different resource types
 */
class FrontmatterGenerator {
	constructor(spellClassLookup = null) {
		this.spellClassLookup = spellClassLookup;
	}

	/**
	 * Generate frontmatter for any resource type
	 */
	generate(entry, entryType, entryHash) {
		const base = this._generateBase(entry, entryType, entryHash);

		// Add resource-specific metadata
		let result;
		switch (entryType) {
			case "spell":
				result = {...base, ...this._generateSpell(entry, this.spellClassLookup)};
				// Add class-specific tags if classes were found
				if (result.classes && result.classes.length > 0) {
					result.tags = [...(result.tags || [])];
					for (const className of result.classes) {
						result.tags.push(`dnd5e/spell/class-${className.toLowerCase()}`);
					}
				}
				return result;
			case "monster":
				return {...base, ...this._generateMonster(entry)};
			case "item":
			case "baseitem":
				return {...base, ...this._generateItem(entry)};
			case "class":
				return {...base, ...this._generateClass(entry)};
			case "subclass":
				return {...base, ...this._generateSubclass(entry)};
			case "race":
				return {...base, ...this._generateRace(entry)};
			case "background":
				return {...base, ...this._generateBackground(entry)};
			case "feat":
				return {...base, ...this._generateFeat(entry)};
			case "condition":
			case "disease":
				return {...base, ...this._generateCondition(entry)};
			case "deity":
				return {...base, ...this._generateDeity(entry)};
			default:
				return base;
		}
	}

	/**
	 * Generate base frontmatter common to all entries
	 */
	_generateBase(entry, entryType, entryHash) {
		const tags = this._generateTags(entry, entryType);

		return {
			name: entry.name || "Unknown",
			source: entry.source || "Unknown",
			page: entry.page,
			type: entryType,
			tags,
			aliases: this._generateAliases(entry, entryType),
			export_version: 1,
			export_timestamp: new Date().toISOString(),
			source_hash: entryHash.substring(0, 12),
		};
	}

	/**
	 * Generate tags for Obsidian
	 */
	_generateTags(entry, entryType) {
		const tags = [`dnd5e/${entryType}`];

		if (entry.source) {
			tags.push(`dnd5e/source-${entry.source.toLowerCase()}`);
		}

		// Type-specific tags
		if (entryType === "spell" && entry.level !== undefined) {
			tags.push(`dnd5e/spell/level-${entry.level}`);
			if (entry.school) {
				const schoolMap = {C: "conjuration", A: "abjuration", E: "evocation", I: "illusion", D: "divination", N: "necromancy", T: "transmutation", V: "enchantment"};
				const schoolName = schoolMap[entry.school] || entry.school;
				tags.push(`dnd5e/spell/school-${schoolName}`);
			}
		}

		if (entryType === "monster" && entry.cr) {
			const crStr = typeof entry.cr === "object" ? entry.cr.cr : entry.cr;
			tags.push(`dnd5e/monster/cr-${crStr}`.replace("/", "-"));
		}

		if (entryType === "item" && entry.rarity) {
			tags.push(`dnd5e/item/rarity-${entry.rarity.toLowerCase()}`);
		}

		return tags;
	}

	/**
	 * Generate aliases for the entry
	 */
	_generateAliases(entry, entryType) {
		const aliases = [];

		// Add "Name (SOURCE)" format as alias
		if (entry.name && entry.source) {
			aliases.push(`${entry.name} (${entry.source})`);
		}

		// Add alternate names if present
		if (entry.alias && Array.isArray(entry.alias)) {
			aliases.push(...entry.alias);
		}

		return aliases;
	}

	/**
	 * Generate spell-specific frontmatter
	 */
	_generateSpell(spell, spellClassLookup) {
		const fm = {
			level: spell.level,
		};

		// School
		if (spell.school) {
			const schoolMap = {C: "conjuration", A: "abjuration", E: "evocation", I: "illusion", D: "divination", N: "necromancy", T: "transmutation", V: "enchantment"};
			fm.school = schoolMap[spell.school] || spell.school;
		}

		// Casting time
		if (spell.time && spell.time[0]) {
			fm.casting_time = `${spell.time[0].number} ${spell.time[0].unit}`;
		}

		// Range
		if (spell.range) {
			if (spell.range.type === "point" && spell.range.distance) {
				fm.range = `${spell.range.distance.amount} ${spell.range.distance.type}`;
			} else {
				fm.range = spell.range.type;
			}
		}

		// Components
		if (spell.components) {
			fm.components = {
				verbal: !!spell.components.v,
				somatic: !!spell.components.s,
				material: spell.components.m ? (typeof spell.components.m === "string" ? spell.components.m : true) : false,
			};
		}

		// Duration
		if (spell.duration && spell.duration[0]) {
			const dur = spell.duration[0];
			if (dur.type === "timed") {
				fm.duration = `${dur.duration.amount} ${dur.duration.type}`;
				fm.concentration = !!dur.concentration;
			} else {
				fm.duration = dur.type;
			}
		}

		// Ritual
		if (spell.meta?.ritual) {
			fm.ritual = true;
		}

		// Classes - extract from lookup data
		const classes = this._getSpellClasses(spell, spellClassLookup);
		if (classes && classes.length > 0) {
			fm.classes = classes;
		}

		// Damage type
		if (spell.damageInflict) {
			fm.damage_type = spell.damageInflict;
		}

		// Saving throw
		if (spell.savingThrow) {
			fm.saving_throw = spell.savingThrow;
		}

		return fm;
	}

	/**
	 * Extract classes that can cast a spell from lookup data
	 */
	_getSpellClasses(spell, spellClassLookup) {
		if (!spellClassLookup) return [];

		const spellName = spell.name.toLowerCase();
		const source = spell.source.toLowerCase();

		// Navigate through the lookup structure
		const classes = new Set();

		try {
			// Check each source book in the lookup
			for (const [lookupSource, spells] of Object.entries(spellClassLookup)) {
				if (spells[spellName]) {
					const spellData = spells[spellName];

					// Add classes from "class" field
					if (spellData.class) {
						for (const [sourceBook, classList] of Object.entries(spellData.class)) {
							for (const className of Object.keys(classList)) {
								classes.add(className);
							}
						}
					}

					// Optionally add classVariant
					if (spellData.classVariant) {
						for (const [sourceBook, classList] of Object.entries(spellData.classVariant)) {
							for (const className of Object.keys(classList)) {
								classes.add(className);
			}
						}
					}
				}
			}
		} catch (e) {
			// Silently fail if lookup structure is unexpected
		}

		return Array.from(classes).sort();
	}

	/**
	 * Generate monster-specific frontmatter
	 */
	_generateMonster(monster) {
		const fm = {};

		// Size and type
		if (monster.size) {
			const sizeMap = {T: "Tiny", S: "Small", M: "Medium", L: "Large", H: "Huge", G: "Gargantuan"};
			fm.size = Array.isArray(monster.size) ? monster.size.map(s => sizeMap[s] || s) : [sizeMap[monster.size] || monster.size];
		}

		if (monster.type) {
			fm.creature_type = typeof monster.type === "string" ? monster.type : monster.type.type;
		}

		// Alignment
		if (monster.alignment) {
			fm.alignment = monster.alignment;
		}

		// CR
		if (monster.cr) {
			fm.cr = typeof monster.cr === "object" ? monster.cr.cr : monster.cr;
		}

		// AC
		if (monster.ac) {
			fm.ac = Array.isArray(monster.ac) ? monster.ac : [monster.ac];
		}

		// HP
		if (monster.hp) {
			fm.hp = monster.hp.average || monster.hp.special;
		}

		// Speed
		if (monster.speed) {
			fm.speed = monster.speed;
		}

		// Ability scores
		if (monster.str !== undefined) fm.str = monster.str;
		if (monster.dex !== undefined) fm.dex = monster.dex;
		if (monster.con !== undefined) fm.con = monster.con;
		if (monster.int !== undefined) fm.int = monster.int;
		if (monster.wis !== undefined) fm.wis = monster.wis;
		if (monster.cha !== undefined) fm.cha = monster.cha;

		// Skills
		if (monster.skill) fm.skills = monster.skill;

		// Senses
		if (monster.senses) fm.senses = monster.senses;

		// Languages
		if (monster.languages) fm.languages = monster.languages;

		return fm;
	}

	/**
	 * Generate item-specific frontmatter
	 */
	_generateItem(item) {
		const fm = {};

		// Get human-readable type information
		const [typeListText, typeHtml, subTypeHtml] = Renderer.item.getHtmlAndTextTypes(item);

		// Item category (weapon, armor, wondrous item, etc.)
		if (typeListText && typeListText.length > 0) {
			fm.item_category = typeListText[0]; // Primary category
		}

		// Weapon/armor specific info
		if (item.weaponCategory) {
			fm.weapon_category = item.weaponCategory; // simple, martial
		}

		if (item.dmgType) {
			fm.damage_type = Parser.dmgTypeToFull(item.dmgType); // Slashing, Piercing, Bludgeoning
		}

		// Rarity
		if (item.rarity) {
			fm.rarity = item.rarity;
		}

		// Attunement
		if (item.reqAttune !== undefined) {
			fm.requires_attunement = typeof item.reqAttune === "string" ? item.reqAttune : !!item.reqAttune;
		}

		// Weight
		if (item.weight) {
			fm.weight = item.weight;
		}

		// Value (in copper pieces, convert to gp for frontmatter)
		if (item.value) {
			fm.value_cp = item.value;
			fm.value_gp = item.value / 100;
		}

		// Weapon damage
		if (item.dmg1) {
			fm.damage = item.dmg1;
		}

		// Armor AC
		if (item.ac !== undefined) {
			fm.armor_class = item.ac;
		}

		// Properties (expanded to human-readable)
		if (item.property && item.property.length > 0) {
			fm.properties = item.property.map(p => {
				const prop = Renderer.item.getProperty(p?.uid || p);
				return prop?.name || p;
			});
		}

		// Weapon Mastery
		if (item.mastery && item.mastery.length > 0) {
			fm.mastery = item.mastery.map(m => {
				// Extract mastery name from "Name|Source" format
				const masteryStr = typeof m === 'string' ? m : m?.uid || m;
				return masteryStr.split('|')[0];
			});
		}

		return fm;
	}

	/**
	 * Generate class-specific frontmatter
	 */
	_generateClass(cls) {
		const fm = {};

		// Hit die
		if (cls.hd) {
			fm.hit_die = `d${cls.hd.faces}`;
		}

		// Primary ability
		if (cls.primaryAbility) {
			fm.primary_ability = cls.primaryAbility;
		}

		// Proficiencies
		if (cls.proficiency) {
			fm.saving_throws = cls.proficiency;
		}

		// Spellcasting
		if (cls.spellcastingAbility) {
			fm.spellcasting_ability = cls.spellcastingAbility;
		}

		// Caster progression
		if (cls.casterProgression) {
			fm.caster_progression = cls.casterProgression;
		}

		// Subclass title
		if (cls.subclassTitle) {
			fm.subclass_title = cls.subclassTitle;
		}

		return fm;
	}

	/**
	 * Generate subclass-specific frontmatter
	 */
	_generateSubclass(subclass) {
		const fm = {};

		if (subclass.className) {
			fm.class_name = subclass.className;
		}

		if (subclass.shortName) {
			fm.short_name = subclass.shortName;
		}

		return fm;
	}

	/**
	 * Generate race-specific frontmatter
	 */
	_generateRace(race) {
		const fm = {};

		// Size
		if (race.size) {
			fm.size = race.size;
		}

		// Speed
		if (race.speed) {
			fm.speed = race.speed;
		}

		// Ability bonuses
		if (race.ability) {
			fm.ability_bonuses = race.ability;
		}

		return fm;
	}

	/**
	 * Generate background-specific frontmatter
	 */
	_generateBackground(background) {
		const fm = {};

		// Skills
		if (background.skillProficiencies) {
			fm.skill_proficiencies = background.skillProficiencies;
		}

		return fm;
	}

	/**
	 * Generate feat-specific frontmatter
	 */
	_generateFeat(feat) {
		const fm = {};

		// Feat category/type
		if (feat.category) {
			const categoryMap = {
				"D": "Dragonmark",
				"G": "General",
				"O": "Origin",
				"FS": "Fighting Style",
				"FS:P": "Fighting Style Replacement (Paladin)",
				"FS:R": "Fighting Style Replacement (Ranger)",
				"EB": "Epic Boon",
			};
			fm.feat_category = categoryMap[feat.category] || feat.category;
		}

		// Prerequisites - parse to human-readable strings
		if (feat.prerequisite && feat.prerequisite.length > 0) {
			fm.prerequisites = this._parsePrerequisites(feat.prerequisite);
		}

		return fm;
	}

	/**
	 * Parse feat prerequisites to human-readable strings
	 */
	_parsePrerequisites(prereqs) {
		if (!prereqs || !Array.isArray(prereqs)) return [];

		return prereqs.map(prereq => {
			const parts = [];

			// Level
			if (prereq.level) {
				parts.push(`Level ${prereq.level}`);
			}

			// Ability scores
			if (prereq.ability && Array.isArray(prereq.ability)) {
				const abilityParts = prereq.ability.map(abil => {
					const abilityNames = {str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma"};
					for (const [key, value] of Object.entries(abil)) {
						return `${abilityNames[key] || key.toUpperCase()} ${value}`;
					}
				});
				parts.push(abilityParts.join(" or "));
			}

			// Class/race
			if (prereq.race) {
				const races = prereq.race.map(r => r.name || r).join(" or ");
				parts.push(`Race: ${races}`);
			}

			if (prereq.spellcasting || prereq.spellcasting2020) {
				parts.push("Spellcasting or Pact Magic feature");
			}

			if (prereq.proficiency) {
				parts.push(`Proficiency: ${prereq.proficiency.map(p => p.armor || p.weapon || p).join(", ")}`);
			}

			return parts.join(", ");
		}).filter(Boolean);
	}

	/**
	 * Generate condition-specific frontmatter
	 */
	_generateCondition(condition) {
		return {};
	}

	/**
	 * Generate deity-specific frontmatter
	 */
	_generateDeity(deity) {
		const fm = {};

		if (deity.alignment) {
			fm.alignment = deity.alignment;
		}

		if (deity.domains) {
			fm.domains = deity.domains;
		}

		if (deity.pantheon) {
			fm.pantheon = deity.pantheon;
		}

		return fm;
	}
}

/**
 * Formats markdown content for different resource types
 */
class MarkdownFormatter {
	constructor(renderer) {
		this.renderer = renderer;
	}

	/**
	 * Format a complete entry as markdown
	 */
	format(entry, entryType, frontmatter) {
		// Generate frontmatter YAML
		const yaml = this._generateYAML(frontmatter);

		// Generate content based on type
		let content;
		switch (entryType) {
			case "spell":
				content = this._formatSpell(entry);
				break;
			case "monster":
				content = this._formatMonster(entry);
				break;
			case "item":
			case "baseitem":
				content = this._formatItem(entry);
				break;
			case "class":
				content = this._formatClass(entry);
				break;
			case "feat":
				content = this._formatFeat(entry);
				break;
			default:
				content = this._formatGeneric(entry);
				break;
		}

		// Assemble complete markdown
		return `${yaml}\n${content}`;
	}

	/**
	 * Generate YAML frontmatter block
	 */
	_generateYAML(frontmatter) {
		const lines = ["---"];

		for (const [key, value] of Object.entries(frontmatter)) {
			if (value === undefined || value === null) continue;

			if (typeof value === "string") {
				// Escape quotes and wrap in quotes if needed
				const needsQuotes = value.includes(":") || value.includes("#") || value.includes("'") || value.includes('"');
				lines.push(`${key}: ${needsQuotes ? `"${value.replace(/"/g, '\\"')}"` : value}`);
			} else if (typeof value === "number" || typeof value === "boolean") {
				lines.push(`${key}: ${value}`);
			} else if (Array.isArray(value)) {
				if (value.length === 0) {
					lines.push(`${key}: []`);
				} else {
					lines.push(`${key}:`);
					for (const item of value) {
						if (typeof item === "string") {
							lines.push(`  - "${item}"`);
						} else {
							lines.push(`  - ${item}`);
						}
					}
				}
			} else if (typeof value === "object") {
				lines.push(`${key}:`);
				for (const [subKey, subValue] of Object.entries(value)) {
					if (typeof subValue === "string") {
						lines.push(`  ${subKey}: "${subValue}"`);
					} else {
						lines.push(`  ${subKey}: ${subValue}`);
					}
				}
			}
		}

		lines.push("---");
		return lines.join("\n");
	}

	/**
	 * Format spell content
	 */
	_formatSpell(spell) {
		const parts = [];

		// Title
		parts.push(`# ${spell.name}\n`);

		// Spell level and school
		if (spell.level !== undefined) {
			const levelStr = spell.level === 0 ? "cantrip" : `${spell.level}${this._getOrdinalSuffix(spell.level)}-level`;
			const schoolMap = {C: "conjuration", A: "abjuration", E: "evocation", I: "illusion", D: "divination", N: "necromancy", T: "transmutation", V: "enchantment"};
			const schoolStr = schoolMap[spell.school] || spell.school || "";
			parts.push(`*${levelStr} ${schoolStr}${spell.meta?.ritual ? " (ritual)" : ""}*\n`);
		}

		// Spell properties
		const props = [];
		if (spell.time && spell.time[0]) {
			props.push(`**Casting Time:** ${spell.time[0].number} ${spell.time[0].unit}`);
		}
		if (spell.range) {
			if (spell.range.type === "point" && spell.range.distance) {
				props.push(`**Range:** ${spell.range.distance.amount} ${spell.range.distance.type}`);
			} else {
				props.push(`**Range:** ${spell.range.type}`);
			}
		}
		if (spell.components) {
			const comps = [];
			if (spell.components.v) comps.push("V");
			if (spell.components.s) comps.push("S");
			if (spell.components.m) {
				const matStr = typeof spell.components.m === "string" ? ` (${spell.components.m})` : "";
				comps.push(`M${matStr}`);
			}
			props.push(`**Components:** ${comps.join(", ")}`);
		}
		if (spell.duration && spell.duration[0]) {
			const dur = spell.duration[0];
			let durStr;
			if (dur.type === "timed") {
				durStr = `${dur.duration.amount} ${dur.duration.type}`;
				if (dur.concentration) durStr = `Concentration, up to ${durStr}`;
			} else {
				durStr = dur.type.charAt(0).toUpperCase() + dur.type.slice(1);
			}
			props.push(`**Duration:** ${durStr}`);
		}

		parts.push(props.join("  \n") + "\n");

		// Description
		if (spell.entries) {
			parts.push(this._renderEntries(spell.entries));
		}

		// At Higher Levels
		if (spell.entriesHigherLevel && spell.entriesHigherLevel.length > 0) {
			parts.push("\n" + this._renderEntries(spell.entriesHigherLevel));
		}

		// Source
		if (spell.source) {
			const sourceFull = Parser.sourceJsonToFull(spell.source);
			const pageStr = spell.page ? `, page ${spell.page}` : "";
			parts.push(`\n---\n**Source:** *${sourceFull}*${pageStr}`);
		}

		return parts.join("\n");
	}

	/**
	 * Format monster content
	 */
	_formatMonster(monster) {
		const parts = [];

		// Title
		parts.push(`# ${monster.name}\n`);

		// Size, type, alignment
		const typeStr = [];
		if (monster.size) {
			const sizeMap = {T: "Tiny", S: "Small", M: "Medium", L: "Large", H: "Huge", G: "Gargantuan"};
			const sizes = Array.isArray(monster.size) ? monster.size : [monster.size];
			typeStr.push(sizes.map(s => sizeMap[s] || s).join(" or "));
		}
		if (monster.type) {
			const type = typeof monster.type === "string" ? monster.type : monster.type.type;
			typeStr.push(type);
		}
		if (monster.alignment) {
			const alignments = Array.isArray(monster.alignment) ? monster.alignment : [monster.alignment];
			typeStr.push(Parser.alignmentListToFull(alignments));
		}

		if (typeStr.length) {
			parts.push(`*${typeStr.join(" ")}*\n`);
		}

		// Stats block
		const stats = [];
		if (monster.ac) {
			const acStr = Array.isArray(monster.ac) ? monster.ac.map(ac => typeof ac === "number" ? ac : ac.ac).join(", ") : monster.ac;
			stats.push(`**Armor Class** ${acStr}`);
		}
		if (monster.hp) {
			const hpStr = monster.hp.average || monster.hp.special;
			const formulaStr = monster.hp.formula ? ` (${monster.hp.formula})` : "";
			stats.push(`**Hit Points** ${hpStr}${formulaStr}`);
		}
		if (monster.speed) {
			stats.push(`**Speed** ${Parser.getSpeedString(monster)}`);
		}

		if (stats.length) {
			parts.push(stats.join("  \n") + "\n");
		}

		// Ability scores
		if (monster.str !== undefined) {
			const abilities = [];
			abilities.push(`| STR | DEX | CON | INT | WIS | CHA |`);
			abilities.push(`|-----|-----|-----|-----|-----|-----|`);
			const scores = [
				`${monster.str} (${Parser.getAbilityModifier(monster.str)})`,
				`${monster.dex} (${Parser.getAbilityModifier(monster.dex)})`,
				`${monster.con} (${Parser.getAbilityModifier(monster.con)})`,
				`${monster.int} (${Parser.getAbilityModifier(monster.int)})`,
				`${monster.wis} (${Parser.getAbilityModifier(monster.wis)})`,
				`${monster.cha} (${Parser.getAbilityModifier(monster.cha)})`,
			];
			abilities.push(`| ${scores.join(" | ")} |`);
			parts.push(abilities.join("\n") + "\n");
		}

		// Additional stats (saves, skills, etc.)
		const additionalStats = [];
		if (monster.save) {
			const saves = [];
			for (const [ability, value] of Object.entries(monster.save)) {
				saves.push(`${ability.toUpperCase()} ${value}`);
			}
			additionalStats.push(`**Saving Throws** ${saves.join(", ")}`);
		}
		if (monster.skill) {
			const skills = [];
			for (const [skill, value] of Object.entries(monster.skill)) {
				const skillName = skill.charAt(0).toUpperCase() + skill.slice(1);
				skills.push(`${skillName} ${value}`);
			}
			additionalStats.push(`**Skills** ${skills.join(", ")}`);
		}
		if (monster.senses) {
			const senses = Array.isArray(monster.senses) ? monster.senses.join(", ") : monster.senses;
			additionalStats.push(`**Senses** ${senses}`);
		}
		if (monster.passive !== undefined) {
			additionalStats.push(`**Passive Perception** ${monster.passive}`);
		}
		if (monster.languages) {
			const langs = Array.isArray(monster.languages) ? monster.languages.join(", ") : monster.languages;
			additionalStats.push(`**Languages** ${langs}`);
		}
		if (monster.cr !== undefined) {
			const cr = typeof monster.cr === "object" ? monster.cr.cr : monster.cr;
			additionalStats.push(`**Challenge** ${cr}`);
		}

		if (additionalStats.length) {
			parts.push(additionalStats.join("  \n") + "\n");
		}

		// Traits
		if (monster.trait && monster.trait.length) {
			parts.push("## Traits\n");
			for (const trait of monster.trait) {
				if (trait.name) {
					parts.push(`### ${trait.name}\n`);
				}
				if (trait.entries) {
					parts.push(this._renderEntries(trait.entries) + "\n");
				}
			}
		}

		// Spellcasting
		if (monster.spellcasting && monster.spellcasting.length) {
			for (const sc of monster.spellcasting) {
				if (sc.name) {
					parts.push(`### ${sc.name}\n`);
				}
				if (sc.headerEntries) {
					parts.push(this._renderEntries(sc.headerEntries) + "\n");
				}
				if (sc.spells) {
					// Format spell list
					for (const [level, spellData] of Object.entries(sc.spells)) {
						if (spellData.spells && spellData.spells.length) {
							const levelStr = level === "0" ? "Cantrips" : `${level}${this._getOrdinalSuffix(parseInt(level))} level`;
							const slots = spellData.slots ? ` (${spellData.slots} slots)` : "";
							parts.push(`**${levelStr}${slots}:** ${spellData.spells.join(", ")}\n`);
						}
					}
				}
				if (sc.footerEntries) {
					parts.push(this._renderEntries(sc.footerEntries) + "\n");
				}
			}
		}

		// Actions
		if (monster.action && monster.action.length) {
			parts.push("## Actions\n");
			for (const action of monster.action) {
				if (action.name) {
					parts.push(`### ${action.name}\n`);
				}
				if (action.entries) {
					parts.push(this._renderEntries(action.entries) + "\n");
				}
			}
		}

		// Bonus Actions
		if (monster.bonus && monster.bonus.length) {
			parts.push("## Bonus Actions\n");
			for (const bonus of monster.bonus) {
				if (bonus.name) {
					parts.push(`### ${bonus.name}\n`);
				}
				if (bonus.entries) {
					parts.push(this._renderEntries(bonus.entries) + "\n");
				}
			}
		}

		// Reactions
		if (monster.reaction && monster.reaction.length) {
			parts.push("## Reactions\n");
			for (const reaction of monster.reaction) {
				if (reaction.name) {
					parts.push(`### ${reaction.name}\n`);
				}
				if (reaction.entries) {
					parts.push(this._renderEntries(reaction.entries) + "\n");
				}
			}
		}

		// Legendary Actions
		if (monster.legendary && monster.legendary.length) {
			parts.push("## Legendary Actions\n");
			for (const legendary of monster.legendary) {
				if (legendary.name) {
					parts.push(`### ${legendary.name}\n`);
				}
				if (legendary.entries) {
					parts.push(this._renderEntries(legendary.entries) + "\n");
				}
			}
		}

		// Mythic Actions
		if (monster.mythic && monster.mythic.length) {
			parts.push("## Mythic Actions\n");
			for (const mythic of monster.mythic) {
				if (mythic.name) {
					parts.push(`### ${mythic.name}\n`);
				}
				if (mythic.entries) {
					parts.push(this._renderEntries(mythic.entries) + "\n");
				}
			}
		}

		// Lair Actions
		if (monster.lair && monster.lair.length) {
			parts.push("## Lair Actions\n");
			for (const lair of monster.lair) {
				if (lair.entries) {
					parts.push(this._renderEntries(lair.entries) + "\n");
				}
			}
		}

		// Regional Effects
		if (monster.regional && monster.regional.length) {
			parts.push("## Regional Effects\n");
			for (const regional of monster.regional) {
				if (regional.entries) {
					parts.push(this._renderEntries(regional.entries) + "\n");
				}
			}
		}

		// Source
		if (monster.source) {
			const sourceFull = Parser.sourceJsonToFull(monster.source);
			const pageStr = monster.page ? `, page ${monster.page}` : "";
			parts.push(`\n---\n**Source:** *${sourceFull}*${pageStr}`);
		}

		return parts.join("\n");
	}

	/**
	 * Format item content
	 */
	_formatItem(item) {
		const parts = [];

		// Title
		parts.push(`# ${item.name}\n`);

		// Get type, rarity, and attunement using renderer utilities
		const [typeListText, typeHtml, subTypeHtml] = Renderer.item.getHtmlAndTextTypes(item);
		const typeStr = [];

		// Use the human-readable type from typeHtml (strip HTML tags)
		if (typeHtml) {
			const cleanType = typeHtml.replace(/<[^>]*>/g, "").replace(/\{@[^}]*\}/g, match => {
				// Extract just the display text from {@item name|source} tags
				const parts = match.replace(/^\{@\w+\s+/, "").replace(/\}$/, "").split("|");
				return parts[0];
			});
			typeStr.push(cleanType);
		}

		if (item.rarity && item.rarity !== "none") {
			typeStr.push(item.rarity);
		}

		if (item.reqAttune) {
			const attuneStr = typeof item.reqAttune === "string" ? `requires attunement ${item.reqAttune}` : "requires attunement";
			typeStr.push(`(${attuneStr})`);
		}

		if (typeStr.length) {
			parts.push(`*${typeStr.join(", ")}*\n`);
		}

		// Weapon/Armor properties
		const [ptDamage, ptProperties] = Renderer.item.getRenderedDamageAndProperties(item, {renderer: this.renderer});
		if (ptDamage || ptProperties || item.property) {
			const propParts = [];
			if (item.weaponCategory) {
				propParts.push(`**Weapon (${item.weaponCategory})**`);
			}
			if (ptDamage) {
				propParts.push(`**Damage/AC:** ${ptDamage}`);
			}

			// Show expanded property names with wikilinks
			if (item.property && item.property.length > 0) {
				const expandedProps = item.property.map(p => {
					// Extract property code and source
					const propStr = typeof p === 'string' ? p : p?.uid || '';
					const [propCode, source] = propStr.split('|');

					// Try to get property from renderer first
					const prop = Renderer.item.getProperty(p?.uid || p);
					const propertyName = prop?.name;

					// Fallback to manual mapping for common properties
					const propertyMap = {
						'A': 'Ammunition',
						'AF': 'Ammunition (futuristic)',
						'F': 'Finesse',
						'H': 'Heavy',
						'L': 'Light',
						'LD': 'Loading',
						'R': 'Reach',
						'S': 'Special',
						'T': 'Thrown',
						'2H': 'Two-Handed',
						'V': 'Versatile',
						'RLD': 'Reload',
						'BF': 'Burst Fire',
						'M': 'Martial',
					};

					const name = propertyName || propertyMap[propCode] || propCode;

					// Create wikilink for standard weapon properties (those we have files for)
					const linkableProperties = ['Ammunition', 'Finesse', 'Heavy', 'Light', 'Loading', 'Range', 'Reach', 'Thrown', 'Two-Handed', 'Versatile'];
					if (linkableProperties.includes(name) && source) {
						return `[[weapon-properties/${name} (${source})]]`;
					}

					return name;
				}).join(", ");
				propParts.push(`**Properties:** ${expandedProps}`);
			}

			// Show weapon mastery with links to variant rules
			if (item.mastery && item.mastery.length > 0) {
				const masteryLinks = item.mastery.map(m => {
					// Extract mastery name and source from "Name|Source" format
					const masteryStr = typeof m === 'string' ? m : m?.uid || m;
					const [masteryName, source] = masteryStr.split('|');
					// Create wikilink to variant rule (will be exported later)
					return `[[variant-rules/${masteryName} (${source})]]`;
				}).join(", ");
				propParts.push(`**Mastery:** ${masteryLinks}`);
			}

			if (item.weight) {
				propParts.push(`**Weight:** ${item.weight} lb.`);
			}
			if (item.value) {
				const valueGp = item.value / 100;
				propParts.push(`**Value:** ${valueGp} gp`);
			}
			if (propParts.length) {
				parts.push(propParts.join("  \n") + "\n");
			}
		}

		// Description
		if (item.entries) {
			parts.push(this._renderEntries(item.entries));
		}

		// Source
		if (item.source) {
			const sourceFull = Parser.sourceJsonToFull(item.source);
			const pageStr = item.page ? `, page ${item.page}` : "";
			parts.push(`\n---\n**Source:** *${sourceFull}*${pageStr}`);
		}

		return parts.join("\n");
	}

	/**
	 * Format class content
	 */
	_formatClass(cls) {
		const parts = [];

		// Title
		parts.push(`# ${cls.name}\n`);

		// Hit die and primary ability
		if (cls.hd) {
			parts.push(`**Hit Die:** d${cls.hd.faces}\n`);
		}

		if (cls.primaryAbility || cls.proficiency) {
			const abilities = [];
			if (cls.primaryAbility) {
				const primary = cls.primaryAbility.map(a => {
					const abilMap = {str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma"};
					return Object.keys(a).map(k => abilMap[k]).join(" or ");
				}).join(", ");
				abilities.push(`**Primary Ability:** ${primary}`);
			}
			if (cls.proficiency) {
				const savingThrows = cls.proficiency.map(p => p.toUpperCase()).join(", ");
				abilities.push(`**Saving Throw Proficiencies:** ${savingThrows}`);
			}
			parts.push(abilities.join("  \n") + "\n");
		}

		// Proficiencies
		if (cls.startingProficiencies) {
			const prof = cls.startingProficiencies;
			const profParts = [];

			if (prof.armor) {
				profParts.push(`**Armor:** ${prof.armor.join(", ")}`);
			}
			if (prof.weapons) {
				profParts.push(`**Weapons:** ${prof.weapons.join(", ")}`);
			}
			if (prof.tools) {
				const toolStr = Array.isArray(prof.tools) ? prof.tools.join(", ") : JSON.stringify(prof.tools);
				profParts.push(`**Tools:** ${toolStr}`);
			}
			if (prof.skills) {
				// Skills is complex - can have choose structures
				profParts.push(`**Skills:** Choose from class skill list`);
			}

			if (profParts.length) {
				parts.push("## Proficiencies\n");
				parts.push(profParts.join("  \n") + "\n");
			}
		}

		// Spellcasting
		if (cls.spellcastingAbility) {
			const spellParts = [];
			const abilMap = {str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma"};
			spellParts.push(`**Spellcasting Ability:** ${abilMap[cls.spellcastingAbility] || cls.spellcastingAbility}`);

			if (cls.casterProgression) {
				spellParts.push(`**Caster Progression:** ${cls.casterProgression}`);
			}

			parts.push("## Spellcasting\n");
			parts.push(spellParts.join("  \n") + "\n");
		}

		// Class features
		if (cls.classFeatures && cls.classFeatures.length) {
			parts.push("## Class Features\n");
			parts.push("As a " + cls.name.toLowerCase() + ", you gain the following class features:\n");

			// Group features by level
			const featuresByLevel = {};
			for (const feature of cls.classFeatures) {
				const featureName = typeof feature === "string" ? feature : feature.classFeature;
				const match = featureName.match(/\|(\d+)(?:\||$)/);
				const level = match ? parseInt(match[1]) : null;

				if (level) {
					if (!featuresByLevel[level]) featuresByLevel[level] = [];
					const displayName = featureName.split("|")[0];
					featuresByLevel[level].push(displayName);
				}
			}

			// List features by level
			for (const level of Object.keys(featuresByLevel).sort((a, b) => parseInt(a) - parseInt(b))) {
				parts.push(`**Level ${level}:** ${featuresByLevel[level].join(", ")}\n`);
			}
		}

		// Subclass info
		if (cls.subclassTitle) {
			parts.push(`\n## ${cls.subclassTitle}\n`);
			parts.push(`At 3rd level, you choose a ${cls.subclassTitle.toLowerCase()} that shapes your training and capabilities.\n`);
		}

		// Source
		if (cls.source) {
			const sourceFull = Parser.sourceJsonToFull(cls.source);
			const pageStr = cls.page ? `, page ${cls.page}` : "";
			parts.push(`\n---\n**Source:** *${sourceFull}*${pageStr}`);
		}

		return parts.join("\n");
	}

	/**
	 * Format feat content
	 */
	_formatFeat(entry) {
		const parts = [];

		// Title
		parts.push(`# ${entry.name}\n`);

		// Initialize full entries (required for feats)
		// First try the feat-specific initialization
		Renderer.feat.initFullEntries(entry);

		// If that didn't work, use the generic initializer
		if (!entry._fullEntries && entry.entries) {
			Renderer.utils.initFullEntries_(entry);
		}

		// Description - use _fullEntries if available
		const entriesToRender = entry._fullEntries || entry.entries;
		if (entriesToRender) {
			parts.push(this._renderEntries(entriesToRender));
		}

		// Source
		if (entry.source) {
			const sourceFull = Parser.sourceJsonToFull(entry.source);
			const pageStr = entry.page ? `, page ${entry.page}` : "";
			parts.push(`\n---\n**Source:** *${sourceFull}*${pageStr}`);
		}

		return parts.join("\n");
	}

	/**
	 * Format generic entry content
	 */
	_formatGeneric(entry) {
		const parts = [];

		// Title
		parts.push(`# ${entry.name}\n`);

		// Description
		if (entry.entries) {
			parts.push(this._renderEntries(entry.entries));
		}

		// Source
		if (entry.source) {
			const sourceFull = Parser.sourceJsonToFull(entry.source);
			const pageStr = entry.page ? `, page ${entry.page}` : "";
			parts.push(`\n---\n**Source:** *${sourceFull}*${pageStr}`);
		}

		return parts.join("\n");
	}

	/**
	 * Render entry content using the markdown renderer
	 */
	_renderEntries(entries) {
		const textStack = [""];
		const meta = {depth: 0};
		this.renderer.recursiveRender({entries}, textStack, meta);
		return textStack[0].trim();
	}

	/**
	 * Get ordinal suffix for numbers
	 */
	_getOrdinalSuffix(n) {
		const s = ["th", "st", "nd", "rd"];
		const v = n % 100;
		return s[(v - 20) % 10] || s[v] || s[0];
	}
}

/**
 * Main export engine that orchestrates the markdown export process
 */
class MarkdownExportEngine {
	constructor(options = {}) {
		this.outputDir = options.outputDir || "markdown-export";
		this.dataDir = options.dataDir || "data";
		this.mode = options.mode || "incremental";
		this.verbose = options.verbose || false;

		this.renderer = ObsidianMarkdownRenderer.get();
		this.tracker = new ExportStateTracker();

		this.stats = {
			created: 0,
			updated: 0,
			skipped: 0,
			errors: 0,
		};

		// Load spell-class lookup data
		this.spellClassLookup = null;
		try {
			const lookupPath = path.join(this.dataDir, "generated", "gendata-spell-source-lookup.json");
			if (fs.existsSync(lookupPath)) {
				this.spellClassLookup = readJson(lookupPath);
				this.log("Loaded spell-class lookup data");
			}
		} catch (e) {
			console.warn("Failed to load spell-class lookup, classes won't be added to spells:", e.message);
		}

		// Initialize generators with loaded data
		this.frontmatterGenerator = new FrontmatterGenerator(this.spellClassLookup);
		this.formatter = new MarkdownFormatter(this.renderer);
	}

	/**
	 * Resource type mapping
	 */
	static RESOURCE_TYPE_MAP = {
		spell: {dir: "spells"},
		monster: {dir: "monsters"},
		item: {dir: "items"},
		baseitem: {dir: "items"},
		class: {dir: "classes"},
		subclass: {dir: "subclasses"},
		background: {dir: "backgrounds"},
		feat: {dir: "feats"},
		race: {dir: "races"},
		condition: {dir: "conditions"},
		disease: {dir: "conditions"},
		deity: {dir: "deities"},
		action: {dir: "actions"},
		vehicle: {dir: "vehicles"},
		object: {dir: "objects"},
		optionalfeature: {dir: "optional-features"},
		reward: {dir: "rewards"},
		psionic: {dir: "psionics"},
		variantrule: {dir: "variant-rules"},
		table: {dir: "tables"},
		language: {dir: "languages"},
		trap: {dir: "traps-hazards"},
		hazard: {dir: "traps-hazards"},
		cult: {dir: "cults-boons"},
		boon: {dir: "cults-boons"},
	};

	/**
	 * Main export method
	 */
	async export(options = {}) {
		console.log("Starting markdown export...");

		// Get list of data files
		const files = listFiles({dir: this.dataDir});

		this.log(`Found ${files.length} data files`);

		// Filter by resource types if specified
		let filesToProcess = files;
		if (options.resourceTypes) {
			const resourceTypes = options.resourceTypes.map(r => r.toLowerCase());
			filesToProcess = files.filter(file => {
				// Check if file contains any of the specified resource types
				// This is a simple heuristic - we'll validate when we read the file
				return resourceTypes.some(type => file.includes(type));
			});
			this.log(`Filtered to ${filesToProcess.length} files matching resource types: ${resourceTypes.join(", ")}`);
		}

		// Process each file
		for (const file of filesToProcess) {
			await this.processFile(file, options.force);
		}

		// Save state
		await this.tracker.saveState();

		console.log("\nExport complete!");
		console.log(`  Created: ${this.stats.created}`);
		console.log(`  Updated: ${this.stats.updated}`);
		console.log(`  Skipped: ${this.stats.skipped}`);
		console.log(`  Errors: ${this.stats.errors}`);

		return this.stats;
	}

	/**
	 * Process a single data file
	 */
	async processFile(sourceFile, force = false) {
		this.log(`Processing ${sourceFile}...`);

		// Detect changes
		const changeInfo = await this.tracker.detectChanges(sourceFile);

		if (!changeInfo.changed && !force) {
			this.log(`  No changes detected, skipping`);
			return;
		}

		if (force) {
			// Force mode: read entire file and export all entries
			const data = readJson(sourceFile);
			const fileHash = this.tracker._computeHash(fs.readFileSync(sourceFile, "utf8"));

			for (const [entryType, entries] of Object.entries(data)) {
				if (entryType === "_meta") continue;
				if (!Array.isArray(entries)) continue;

				for (const entry of entries) {
				// Skip entries without required content fields
				// (e.g., foundry-*.json files often have metadata-only entries)
				if (entryType === "feat" && !entry.entries) {
					this.log(`  Skipping ${entry.name} from ${entry.source}: no entries field`);
					continue;
				}

					const entryHash = this.tracker._computeHash(JSON.stringify(entry));
					const entryKey = this.tracker._getEntryKey(entryType, entry);

					try {
						await this.exportEntry({
							entryType,
							entry,
							entryKey,
							entryHash,
						}, sourceFile, fileHash);
					} catch (e) {
						console.error(`  Error exporting ${entryKey}:`, e.message);
						this.stats.errors++;
					}
				}
			}
		} else {
			// Incremental mode: only export changed entries
			this.log(`  ${changeInfo.entries.length} entries changed`);

			for (const changeEntry of changeInfo.entries) {
				try {
					await this.exportEntry(changeEntry, sourceFile, changeInfo.fileHash);
				} catch (e) {
					console.error(`  Error exporting ${changeEntry.entryKey}:`, e.message);
					this.stats.errors++;
				}
			}
		}
	}

	/**
	 * Export a single entry
	 */
	async exportEntry(changeEntry, sourceFile, fileHash) {
		const {entryType, entry, entryKey, entryHash, reason} = changeEntry;

		// Skip entries without required content fields
		// (e.g., foundry-*.json files often have metadata-only entries)
		if (entryType === "feat" && !entry.entries) {
			this.log(`  Skipping ${entry.name} from ${entry.source}: no entries field`);
			this.stats.skipped++;
			return;
		}

		// Get resource directory
		const resourceInfo = MarkdownExportEngine.RESOURCE_TYPE_MAP[entryType];
		if (!resourceInfo) {
			this.log(`  Skipping unknown resource type: ${entryType}`);
			this.stats.skipped++;
			return;
		}

		// Generate filename
		const filename = this._sanitizeFilename(`${entry.name} (${entry.source || "Unknown"}).md`);
		const outputPath = path.join(this.outputDir, resourceInfo.dir, filename);

		// Ensure directory exists
		const outputDirPath = path.dirname(outputPath);
		if (!fs.existsSync(outputDirPath)) {
			fs.mkdirSync(outputDirPath, {recursive: true});
		}

		// Generate frontmatter
		const frontmatter = this.frontmatterGenerator.generate(entry, entryType, entryHash);

		// Generate markdown content
		const markdown = this.formatter.format(entry, entryType, frontmatter);

		// Write file
		fs.writeFileSync(outputPath, markdown, "utf8");

		// Update state
		this.tracker.updateEntryState(sourceFile, fileHash, entryKey, entryHash, outputPath);

		// Update stats
		if (reason === "new") {
			this.stats.created++;
			this.log(`  ✓ Created ${filename}`);
		} else {
			this.stats.updated++;
			this.log(`  ✓ Updated ${filename}`);
		}
	}

	/**
	 * Clean the output directory
	 */
	async cleanOutputDirectory() {
		if (fs.existsSync(this.outputDir)) {
			console.log(`Cleaning output directory: ${this.outputDir}`);
			fs.rmSync(this.outputDir, {recursive: true, force: true});
		}
	}

	/**
	 * Sanitize filename for filesystem
	 */
	_sanitizeFilename(filename) {
		return filename
			.replace(/[<>:"/\\|?*]/g, "-")
			.replace(/\s+/g, " ")
			.trim();
	}

	/**
	 * Log message if verbose mode is enabled
	 */
	log(message) {
		if (this.verbose) {
			console.log(message);
		}
	}
}

export {
	ObsidianMarkdownRenderer,
	ExportStateTracker,
	FrontmatterGenerator,
	MarkdownFormatter,
	MarkdownExportEngine,
};
