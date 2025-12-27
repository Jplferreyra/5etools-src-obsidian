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

		// Generate wikilink: ALWAYS include display text [[resourceDir/Name (SOURCE)|Display Text]]
		const filename = `${cleanName} (${cleanSource})`;
		const wikilink = `[[${resourceDir}/${filename}|${filename}]]`;

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
			case "subrace":
				return {...base, ...this._generateSubrace(entry)};
			case "background":
				return {...base, ...this._generateBackground(entry)};
			case "feat":
				return {...base, ...this._generateFeat(entry)};
			case "condition":
			case "disease":
				return {...base, ...this._generateCondition(entry)};
			case "deity":
				return {...base, ...this._generateDeity(entry)};
			case "language":
				return {...base, ...this._generateLanguage(entry)};
			case "vehicle":
				return {...base, ...this._generateVehicle(entry)};
			case "object":
				return {...base, ...this._generateObject(entry)};
			case "psionic":
				return {...base, ...this._generatePsionic(entry)};
			case "reward":
				return {...base, ...this._generateReward(entry)};
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

		// Alignment - expand codes to full names
		if (monster.alignment) {
			const alignmentMap = {
				'L': 'Lawful',
				'N': 'Neutral',
				'C': 'Chaotic',
				'G': 'Good',
				'E': 'Evil',
				'U': 'Unaligned',
				'A': 'Any'
			};

			if (Array.isArray(monster.alignment)) {
				const expanded = monster.alignment.map(a => {
					if (typeof a === 'string') {
						return alignmentMap[a] || a;
					} else if (typeof a === 'object' && a.alignment) {
						// Handle complex alignment objects
						return a.alignment.map(code => alignmentMap[code] || code).join(' ');
					}
					return a;
				});
				fm.alignment = expanded.join(' ');
			} else if (typeof monster.alignment === 'string') {
				fm.alignment = alignmentMap[monster.alignment] || monster.alignment;
			}
		}

		// CR
		if (monster.cr) {
			fm.cr = typeof monster.cr === "object" ? monster.cr.cr : monster.cr;
		}

		// AC - extract numeric value from AC objects
		if (monster.ac) {
			const acArray = Array.isArray(monster.ac) ? monster.ac : [monster.ac];
			const acValues = acArray.map(ac => {
				if (typeof ac === 'number') {
					return ac;
				} else if (typeof ac === 'object' && ac.ac !== undefined) {
					return ac.ac;
				}
				return ac;
			});
			// Store just the primary AC value or all values if multiple
			fm.ac = acValues.length === 1 ? acValues[0] : acValues;
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

		// Ability bonuses - format as readable array
		if (race.ability && Array.isArray(race.ability)) {
			fm.ability_bonuses = race.ability.map(ab => {
				if (typeof ab === "object" && !ab.choose) {
					// Simple ability bonus like {str: 2, dex: 1}
					const parts = [];
					for (const [key, value] of Object.entries(ab)) {
						if (typeof value === "number") {
							parts.push(`${key.toUpperCase()} +${value}`);
						}
					}
					return parts.join(", ");
				}
				return "Choice";
			});
		}

		return fm;
	}

	/**
	 * Generate subrace-specific frontmatter
	 */
	_generateSubrace(subrace) {
		const fm = {};

		// Base race information
		if (subrace.raceName) {
			fm.base_race = subrace.raceName;
		}
		if (subrace.raceSource) {
			fm.base_race_source = subrace.raceSource;
		}

		// Size
		if (subrace.size) {
			fm.size = subrace.size;
		}

		// Speed
		if (subrace.speed) {
			fm.speed = subrace.speed;
		}

		// Ability bonuses - format as readable array
		if (subrace.ability && Array.isArray(subrace.ability)) {
			fm.ability_bonuses = subrace.ability.map(ab => {
				if (typeof ab === "object" && !ab.choose) {
					// Simple ability bonus like {str: 2, dex: 1}
					const parts = [];
					for (const [key, value] of Object.entries(ab)) {
						if (typeof value === "number") {
							parts.push(`${key.toUpperCase()} +${value}`);
						}
					}
					return parts.join(", ");
				}
				return "Choice";
			});
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

		// Expand alignment codes like we do for monsters
		if (deity.alignment) {
			const alignmentMap = {
				'L': 'Lawful',
				'N': 'Neutral',
				'C': 'Chaotic',
				'G': 'Good',
				'E': 'Evil',
				'U': 'Unaligned',
				'A': 'Any'
			};

			if (Array.isArray(deity.alignment)) {
				const expanded = deity.alignment.map(a => {
					if (typeof a === 'string') {
						return alignmentMap[a] || a;
					}
					return a;
				});
				fm.alignment = expanded.join(' ');
			} else if (typeof deity.alignment === 'string') {
				fm.alignment = alignmentMap[deity.alignment] || deity.alignment;
			}
		}

		if (deity.title) {
			fm.title = deity.title;
		}

		if (deity.domains) {
			fm.domains = deity.domains;
		}

		if (deity.pantheon) {
			fm.pantheon = deity.pantheon;
		}

		if (deity.symbol) {
			fm.symbol = deity.symbol;
		}

		if (deity.province) {
			fm.province = deity.province;
		}

		if (deity.category) {
			fm.category = deity.category;
		}

		return fm;
	}

	/**
	 * Generate language-specific frontmatter
	 */
	_generateLanguage(language) {
		const fm = {};

		// Language type (standard, rare, exotic, secret)
		if (language.type) {
			fm.language_type = language.type;
		}

		// Origin/script
		if (language.origin) {
			fm.origin = language.origin;
		}

		if (language.script) {
			fm.script = language.script;
		}

		return fm;
	}

	/**
	 * Generate vehicle-specific frontmatter
	 */
	_generateVehicle(vehicle) {
		const fm = {};

		if (vehicle.vehicleType) {
			const vehicleTypeMap = {
				'SHIP': 'Ship',
				'SPELLJAMMER': 'Spelljammer',
				'INFWAR': 'Infernal War Machine',
				'CREATURE': 'Creature',
				'OBJECT': 'Object',
				'ELEMENTAL_AIRSHIP': 'Elemental Airship'
			};
			fm.vehicle_type = vehicleTypeMap[vehicle.vehicleType] || vehicle.vehicleType;
		}

		if (vehicle.size) {
			const sizeMap = {T: "Tiny", S: "Small", M: "Medium", L: "Large", H: "Huge", G: "Gargantuan"};
			fm.size = Array.isArray(vehicle.size)
				? vehicle.size.map(s => sizeMap[s] || s)
				: [sizeMap[vehicle.size] || vehicle.size];
		}

		if (vehicle.terrain) {
			fm.terrain = vehicle.terrain;
		}

		if (vehicle.capCrew !== undefined) {
			fm.crew_capacity = vehicle.capCrew;
		}

		if (vehicle.capPassenger !== undefined) {
			fm.passenger_capacity = vehicle.capPassenger;
		}

		// AC
		if (vehicle.ac !== undefined) {
			fm.ac = typeof vehicle.ac === 'object' ? vehicle.ac.ac : vehicle.ac;
		}

		// HP
		if (vehicle.hp !== undefined) {
			fm.hp = typeof vehicle.hp === 'object' ? vehicle.hp.hp : vehicle.hp;
		}

		// Speed
		if (vehicle.speed) {
			fm.speed = vehicle.speed;
		}

		// Immunities
		if (vehicle.immune) {
			fm.damage_immunities = vehicle.immune;
		}

		return fm;
	}

	/**
	 * Generate object-specific frontmatter
	 */
	_generateObject(obj) {
		const fm = {};

		if (obj.objectType) {
			fm.object_type = obj.objectType;
		}

		if (obj.size) {
			const sizeMap = {T: "Tiny", S: "Small", M: "Medium", L: "Large", H: "Huge", G: "Gargantuan"};
			fm.size = Array.isArray(obj.size)
				? obj.size.map(s => sizeMap[s] || s)
				: [sizeMap[obj.size] || obj.size];
		}

		// AC
		if (obj.ac !== undefined) {
			fm.ac = typeof obj.ac === 'object' ? obj.ac.ac : obj.ac;
		}

		// HP
		if (obj.hp !== undefined) {
			fm.hp = typeof obj.hp === 'object' ? obj.hp.hp : obj.hp;
		}

		// Immunities
		if (obj.immune) {
			fm.damage_immunities = obj.immune;
		}

		return fm;
	}

	_generatePsionic(psionic) {
		const fm = {};

		// Psionic type - Discipline or Talent
		if (psionic.type) {
			const typeMap = {
				'D': 'Discipline',
				'T': 'Talent'
			};
			fm.psionic_type = typeMap[psionic.type] || psionic.type;
		}

		// Order (only for disciplines)
		if (psionic.order) {
			fm.order = psionic.order;
		}

		return fm;
	}

	_generateReward(reward) {
		const fm = {};

		// Reward type (Blessing, Boon, Charm, Curse, etc.)
		if (reward.type) {
			fm.reward_type = reward.type;
		}

		return fm;
	}
}

/**
 * Formats markdown content for different resource types
 */
class MarkdownFormatter {
	constructor(renderer, legendaryGroups = []) {
		this.renderer = renderer;
		this.legendaryGroups = legendaryGroups;

		// Build a lookup map for faster access
		this.legendaryGroupMap = new Map();
		if (legendaryGroups) {
			for (const group of legendaryGroups) {
				const key = `${group.name}|${group.source}`.toLowerCase();
				this.legendaryGroupMap.set(key, group);
			}
		}
	}

	/**
	 * Format a complete entry as markdown
	 */
	format(entry, entryType, frontmatter, additionalData = null) {
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
				content = this._formatClass(entry, additionalData);
				break;
			case "subclass":
				content = this._formatSubclass(entry, additionalData);
				break;
			case "feat":
				content = this._formatFeat(entry);
				break;
			case "subrace":
				content = this._formatSubrace(entry);
				break;
			case "language":
				content = this._formatLanguage(entry);
				break;
			case "deity":
				content = this._formatDeity(entry);
				break;
			case "object":
				content = this._formatObject(entry);
				break;
			case "psionic":
				content = this._formatPsionic(entry);
				break;
			case "reward":
				content = this._formatReward(entry);
				break;
			case "table":
				content = this._formatTable(entry);
				break;
			case "vehicle":
				content = this._formatVehicle(entry);
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
			let type = typeof monster.type === "string" ? monster.type : monster.type.type;
			// Add subtype tags in parentheses if they exist
			if (typeof monster.type === "object" && monster.type.tags && monster.type.tags.length > 0) {
				type += ` (${monster.type.tags.join(", ")})`;
			}
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
		// Damage vulnerabilities, resistances, immunities
		if (monster.vulnerable) {
			const vulns = Array.isArray(monster.vulnerable) ? monster.vulnerable.join(", ") : monster.vulnerable;
			additionalStats.push(`**Damage Vulnerabilities** ${vulns}`);
		}
		if (monster.resist) {
			const resists = Array.isArray(monster.resist) ? monster.resist.join(", ") : monster.resist;
			additionalStats.push(`**Damage Resistances** ${resists}`);
		}
		if (monster.immune) {
			const immunes = Array.isArray(monster.immune) ? monster.immune.join(", ") : monster.immune;
			additionalStats.push(`**Damage Immunities** ${immunes}`);
		}
		if (monster.conditionImmune) {
			const condImmunes = Array.isArray(monster.conditionImmune) ? monster.conditionImmune.join(", ") : monster.conditionImmune;
			additionalStats.push(`**Condition Immunities** ${condImmunes}`);
		}
		if (monster.senses) {
			const senses = Array.isArray(monster.senses) ? monster.senses.join(", ") : monster.senses;
			additionalStats.push(`**Senses** ${senses}`);
		}
		if (monster.passive !== undefined) {
			additionalStats.push(`**Passive Perception** ${monster.passive}`);
		}
		// Initiative (if different from DEX modifier or has special bonuses)
		const initBonus = this._getInitiativeBonus(monster);
		if (initBonus !== null) {
			const dexMod = monster.dex !== undefined ? Parser.getAbilityModNumber(monster.dex) : null;
			// Only show initiative if it's different from DEX modifier (expertise, advantage, etc.)
			if (initBonus !== dexMod || (monster.initiative && typeof monster.initiative === "object")) {
				const sign = initBonus >= 0 ? "+" : "";
				additionalStats.push(`**Initiative** ${sign}${initBonus}`);
			}
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
					parts.push(`### ${this._renderString(trait.name)}\n`);
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
					parts.push(`### ${this._renderString(sc.name)}\n`);
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
							// Process each spell through _renderString to convert {@spell} tags to wikilinks
							const spellList = spellData.spells.map(spell => this._renderString(spell)).join(", ");
							parts.push(`**${levelStr}${slots}:** ${spellList}\n`);
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
					parts.push(`### ${this._renderString(action.name)}\n`);
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
					parts.push(`### ${this._renderString(bonus.name)}\n`);
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
					parts.push(`### ${this._renderString(reaction.name)}\n`);
				}
				if (reaction.entries) {
					parts.push(this._renderEntries(reaction.entries) + "\n");
				}
			}
		}

		// Legendary Actions
		if (monster.legendary && monster.legendary.length) {
			parts.push("## Legendary Actions\n");

			// Add legendary actions header text (standard D&D 5e format)
			// The number of actions is typically 3 unless specified otherwise
			const actionCount = monster.legendaryActions || 3;
			const creatureName = monster.isNamedCreature || monster.isNpc ? monster.name : `the ${monster.name.toLowerCase()}`;
			parts.push(`${creatureName.charAt(0).toUpperCase() + creatureName.slice(1)} can take ${actionCount} legendary actions, choosing from the options below. Only one legendary action option can be used at a time and only at the end of another creature's turn. ${creatureName.charAt(0).toUpperCase() + creatureName.slice(1)} regains spent legendary actions at the start of its turn.\n`);

			for (const legendary of monster.legendary) {
				if (legendary.name) {
					parts.push(`### ${this._renderString(legendary.name)}\n`);
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
					parts.push(`### ${this._renderString(mythic.name)}\n`);
				}
				if (mythic.entries) {
					parts.push(this._renderEntries(mythic.entries) + "\n");
				}
			}
		}

		// Lair Actions (from monster data or legendary group)
		let lairActions = monster.lair;
		if (!lairActions && monster.legendaryGroup) {
			const group = this._getLegendaryGroup(monster.legendaryGroup);
			if (group && group.lairActions) {
				lairActions = group.lairActions;
			}
		}
		if (lairActions && lairActions.length) {
			parts.push("## Lair Actions\n");
			parts.push(this._renderEntries(lairActions) + "\n");
		}

		// Regional Effects (from monster data or legendary group)
		let regionalEffects = monster.regional;
		if (!regionalEffects && monster.legendaryGroup) {
			const group = this._getLegendaryGroup(monster.legendaryGroup);
			if (group && group.regionalEffects) {
				regionalEffects = group.regionalEffects;
			}
		}
		if (regionalEffects && regionalEffects.length) {
			parts.push("## Regional Effects\n");
			parts.push(this._renderEntries(regionalEffects) + "\n");
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
						const filename = `${name} (${source})`;
						return `[[weapon-properties/${filename}|${filename}]]`;
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
					const filename = `${masteryName} (${source})`;
					return `[[variant-rules/${filename}|${filename}]]`;
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
	_formatClass(cls, classData) {
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

		// Proficiencies with wikilinks
		if (cls.startingProficiencies) {
			parts.push(this._renderClassProficiencies(cls.startingProficiencies) + "\n");
		}

		// Class Features Table
		if (cls.classFeatures && cls.classFeatures.length) {
			parts.push(this._renderClassTable(cls, classData) + "\n");
		}

		// Detailed Class Features
		if (cls.classFeatures && cls.classFeatures.length && classData?.classFeature) {
			parts.push(this._renderClassFeatureDetails(cls, classData) + "\n");
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
	 * Render class proficiencies with wikilinks
	 */
	_renderClassProficiencies(prof) {
		const parts = ["## Proficiencies\n"];
		const profParts = [];

		if (prof.armor) {
			// Convert armor proficiencies to wikilinks
			const armorLinks = prof.armor.map(a => {
				if (a === "light") return "Light Armor";
				if (a === "medium") return "Medium Armor";
				if (a === "heavy") return "Heavy Armor";
				if (a === "shield") return "Shields";
				return a;
			});
			profParts.push(`**Armor:** ${armorLinks.join(", ")}`);
		}

		if (prof.weapons) {
			// Convert weapon proficiencies to wikilinks
			const weaponLinks = prof.weapons.map(w => {
				if (w === "simple") return "Simple Weapons";
				if (w === "martial") return "Martial Weapons";
				return this._renderString(w);
			});
			profParts.push(`**Weapons:** ${weaponLinks.join(", ")}`);
		}

		if (prof.tools) {
			const toolStr = Array.isArray(prof.tools)
				? prof.tools.map(t => this._renderString(t)).join(", ")
				: this._renderString(JSON.stringify(prof.tools));
			profParts.push(`**Tools:** ${toolStr}`);
		}

		if (prof.skills) {
			// Handle skill selection
			if (Array.isArray(prof.skills)) {
				const first = prof.skills[0];
				if (typeof first === "object") {
					if (first.choose) {
						const choose = first.choose;
						profParts.push(`**Skills:** Choose ${choose.count || 2} from the class skill list`);
					} else if (first.any !== undefined) {
						profParts.push(`**Skills:** Choose ${first.any} from the class skill list`);
					} else {
						profParts.push(`**Skills:** ${JSON.stringify(prof.skills)}`);
					}
				} else {
					profParts.push(`**Skills:** ${prof.skills.join(", ")}`);
				}
			} else {
				profParts.push(`**Skills:** ${prof.skills.toString()}`);
			}
		}

		parts.push(profParts.join("  \n"));
		return parts.join("");
	}

	/**
	 * Render class features table
	 */
	_renderClassTable(cls, classData) {
		const parts = [`## ${cls.name} Features Table\n`];

		// Build table header
		const headers = ["Level", "Proficiency Bonus", "Features"];

		// Add class-specific columns from classTableGroups
		if (cls.classTableGroups) {
			for (const group of cls.classTableGroups) {
				if (group.title) {
					// For spell progression, add the group title as a super-header
					headers.push(`${group.title}`);
				} else if (group.colLabels) {
					// Add each column label
					for (const label of group.colLabels) {
						headers.push(this._renderString(label));
					}
				}
			}
		}

		// Create markdown table
		parts.push(`| ${headers.join(" | ")} |`);
		parts.push(`| ${headers.map(() => "---").join(" | ")} |`);

		// Add rows for levels 1-20
		for (let level = 1; level <= 20; level++) {
			const profBonus = Math.ceil(level / 4) + 1; // Proficiency bonus by level
			const row = [level.toString(), `+${profBonus}`];

			// Get features for this level
			const features = this._getClassFeaturesForLevel(cls, level, classData);
			row.push(features.join(", "));

			// Add class-specific columns
			if (cls.classTableGroups) {
				for (const group of cls.classTableGroups) {
					const levelIndex = level - 1;
					if (group.rowsSpellProgression) {
						// Spell progression table
						const spellRow = group.rowsSpellProgression[levelIndex];
						if (spellRow) {
							row.push(...spellRow.map(slots => slots === 0 ? "—" : slots.toString()));
						}
					} else if (group.rows) {
						// Regular table group
						const groupRow = group.rows[levelIndex];
						if (groupRow) {
							for (const cell of groupRow) {
								if (typeof cell === "object") {
									if (cell.type === "bonus") {
										row.push(`+${cell.value}`);
									} else if (cell.type === "dice") {
										// Render dice notation
										const dice = cell.toRoll[0];
										row.push(`${dice.number}d${dice.faces}`);
									} else {
										// Try to render as entry object
										row.push(this._renderString(cell));
									}
								} else {
									row.push(this._renderString(cell.toString()));
								}
							}
						}
					}
				}
			}

			parts.push(`| ${row.join(" | ")} |`);
		}

		parts.push("");
		return parts.join("\n");
	}

	/**
	 * Get class features for a specific level
	 */
	_getClassFeaturesForLevel(cls, level, classData) {
		const features = [];

		for (const feature of cls.classFeatures) {
			const isSubclassFeature = typeof feature === "object" && feature.gainSubclassFeature;
			const featureName = typeof feature === "string" ? feature : feature.classFeature;
			const match = featureName.match(/\|(\d+)(?:\||$)/);
			const featureLevel = match ? parseInt(match[1]) : null;

			if (featureLevel === level) {
				const displayName = featureName.split("|")[0];

				if (isSubclassFeature) {
					// For subclass selection level, add links to all subclasses
					if (level === 3 || displayName.includes(cls.subclassTitle)) {
						features.push(`[[#${cls.subclassTitle}|${displayName}]]`);
					} else {
						features.push(displayName);
					}
				} else {
					features.push(`[[#${displayName}|${displayName}]]`);
				}
			}
		}

		return features;
	}

	/**
	 * Render detailed class feature descriptions (organized by level)
	 */
	_renderClassFeatureDetails(cls, classData) {
		const parts = [];

		// Group features by level
		const featuresByLevel = {};
		for (const feature of cls.classFeatures) {
			const isSubclassFeature = typeof feature === "object" && feature.gainSubclassFeature;
			const featureName = typeof feature === "string" ? feature : feature.classFeature;
			const match = featureName.match(/\|(\d+)(?:\||$)/);
			const level = match ? parseInt(match[1]) : null;

			if (level) {
				if (!featuresByLevel[level]) featuresByLevel[level] = [];
				featuresByLevel[level].push({featureName, isSubclassFeature});
			}
		}

		// Track if we've already listed subclasses
		let subclassesListed = false;

		// Render each level's features
		for (const level of Object.keys(featuresByLevel).sort((a, b) => parseInt(a) - parseInt(b))) {
			parts.push(`## Level ${level}\n`);

			for (const {featureName, isSubclassFeature} of featuresByLevel[level]) {
				if (isSubclassFeature) {
					// Handle subclass feature
					const subclassFeature = this._findClassFeature(featureName, classData);
					if (subclassFeature) {
						parts.push(`### ${subclassFeature.name}\n`);
						if (subclassFeature.entries) {
							parts.push(this._renderEntries(subclassFeature.entries) + "\n");
						}
					}

					// List all available subclasses only the first time
					if (!subclassesListed && cls.subclassTitle && classData?.subclass) {
						parts.push(`**Available ${cls.subclassTitle} Options:**\n`);
						const subclasses = classData.subclass
							.filter(sc => sc.className === cls.name && sc.classSource === cls.source)
							.sort((a, b) => a.name.localeCompare(b.name));

						for (const sc of subclasses) {
							parts.push(`- [[subclasses/${sc.name} (${sc.source})|${sc.name}]]\n`);
						}
						parts.push("");
						subclassesListed = true;
					} else if (subclassesListed) {
						// Reference the earlier list
						parts.push(`*See the available ${cls.subclassTitle} options listed at Level 3.*\n`);
					}
				} else {
					// Handle regular feature
					const featureData = this._findClassFeature(featureName, classData);
					if (featureData) {
						parts.push(`### ${featureData.name}\n`);
						if (featureData.entries) {
							parts.push(this._renderEntries(featureData.entries) + "\n");
						}
					}
				}
			}
		}

		return parts.join("\n");
	}

	/**
	 * Find a class feature by its reference string
	 */
	_findClassFeature(featureName, classData) {
		if (!classData?.classFeature) return null;

		// Parse the feature reference - handles two formats:
		// PHB format: "Feature Name|ClassName||Level|Source"
		// XPHB format: "Feature Name|ClassName|Source|Level"
		const parts = featureName.split("|");
		const name = parts[0];
		const className = parts[1];

		// Determine format by checking if part 2 is empty (PHB) or has content (XPHB)
		let level, source;
		if (parts[2] === "") {
			// PHB format
			level = parts[3] ? parseInt(parts[3]) : null;
			source = parts[4];
		} else {
			// XPHB format
			source = parts[2];
			level = parts[3] ? parseInt(parts[3]) : null;
		}

		return classData.classFeature.find(f =>
			f.name === name &&
			f.className === className &&
			(!level || f.level === level) &&
			(!source || f.source === source)
		);
	}

	/**
	 * Format subclass content
	 */
	_formatSubclass(subclass, classData) {
		const parts = [];

		// Title
		parts.push(`# ${subclass.name}\n`);

		// Class info
		if (subclass.className) {
			parts.push(`**Class:** [[classes/${subclass.className} (${subclass.classSource})|${subclass.className}]]\n`);
		}

		// Subclass features table (if has features at multiple levels)
		if (subclass.subclassFeatures && subclass.subclassFeatures.length > 1) {
			parts.push(this._renderSubclassTable(subclass) + "\n");
		}

		// Detailed Subclass Features
		if (subclass.subclassFeatures && subclass.subclassFeatures.length && classData?.subclassFeature) {
			parts.push(this._renderSubclassFeatureDetails(subclass, classData) + "\n");
		}

		// Source
		if (subclass.source) {
			const sourceFull = Parser.sourceJsonToFull(subclass.source);
			const pageStr = subclass.page ? `, page ${subclass.page}` : "";
			parts.push(`\n---\n**Source:** *${sourceFull}*${pageStr}`);
		}

		return parts.join("\n");
	}

	/**
	 * Render subclass features table
	 */
	_renderSubclassTable(subclass) {
		const parts = [`## ${subclass.name} Features\n`];

		// Build table
		parts.push(`| Level | Feature |`);
		parts.push(`| --- | --- |`);

		// Add rows for each subclass feature
		for (const feature of subclass.subclassFeatures) {
			const featureName = typeof feature === "string" ? feature : feature.subclassFeature;
			const match = featureName.match(/\|(\d+)(?:\||$)/);
			const level = match ? parseInt(match[1]) : null;

			if (level) {
				const displayName = featureName.split("|")[0];
				parts.push(`| ${level} | [[#${displayName}|${displayName}]] |`);
			}
		}

		parts.push("");
		return parts.join("\n");
	}

	/**
	 * Render detailed subclass feature descriptions (organized by level)
	 */
	_renderSubclassFeatureDetails(subclass, classData) {
		const parts = [];

		// Group features by level
		const featuresByLevel = {};
		for (const feature of subclass.subclassFeatures) {
			const featureName = typeof feature === "string" ? feature : feature.subclassFeature;
			const match = featureName.match(/\|(\d+)(?:\||$)/);
			const level = match ? parseInt(match[1]) : null;

			if (level) {
				if (!featuresByLevel[level]) featuresByLevel[level] = [];
				featuresByLevel[level].push(featureName);
			}
		}

		// Render each level's features
		for (const level of Object.keys(featuresByLevel).sort((a, b) => parseInt(a) - parseInt(b))) {
			parts.push(`## Level ${level}\n`);

			for (const featureName of featuresByLevel[level]) {
				const featureData = this._findSubclassFeature(featureName, classData);

				if (featureData) {
					// Feature heading
					parts.push(`### ${featureData.name}\n`);

					// Feature description
					if (featureData.entries) {
						parts.push(this._renderEntries(featureData.entries) + "\n");
					}
				}
			}
		}

		return parts.join("\n");
	}

	/**
	 * Find a subclass feature by its reference string
	 */
	_findSubclassFeature(featureName, classData) {
		if (!classData?.subclassFeature) return null;

		// Parse the feature reference - handles multiple formats:
		// PHB format (6 parts): "Feature Name|ClassName||SubclassName||Level|Source"
		// XPHB format (6 parts): "Feature Name|ClassName|Source|SubclassName|Source|Level"
		// Extended format (7 parts): "Feature Name|ClassName|ClassSource|SubclassName|SubclassSource|Level|Source"
		const parts = featureName.split("|");
		const name = parts[0];
		const className = parts[1];

		let subclassShortName, level, source, classSource, subclassSource;

		if (parts.length === 7) {
			// Extended format with both classSource and subclassSource
			classSource = parts[2];
			subclassShortName = parts[3];
			subclassSource = parts[4];
			level = parts[5] ? parseInt(parts[5]) : null;
			source = parts[6];
		} else if (parts[2] === "") {
			// PHB format
			subclassShortName = parts[3];
			level = parts[5] ? parseInt(parts[5]) : null;
			source = parts[6];
		} else {
			// XPHB format
			source = parts[2];
			subclassShortName = parts[3];
			level = parts[5] ? parseInt(parts[5]) : null;
		}

		return classData.subclassFeature.find(f =>
			f.name === name &&
			f.className === className &&
			f.subclassShortName === subclassShortName &&
			(!level || f.level === level) &&
			(!source || f.source === source) &&
			(!classSource || f.classSource === classSource) &&
			(!subclassSource || f.subclassSource === subclassSource)
		);
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
	 * Format subrace content
	 */
	_formatSubrace(entry) {
		const parts = [];

		// Title - include base race name
		const fullName = entry.raceName ? `${entry.name} ${entry.raceName}` : entry.name;
		parts.push(`# ${fullName}\n`);

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
	 * Format language content
	 */
	_formatLanguage(entry) {
		const parts = [];

		// Title
		parts.push(`# ${entry.name}\n`);

		// Type
		if (entry.type) {
			const typeMap = {
				'standard': 'Standard Language',
				'exotic': 'Exotic Language',
				'rare': 'Rare Language',
				'secret': 'Secret Language'
			};
			const typeStr = typeMap[entry.type] || entry.type;
			parts.push(`*${typeStr}*\n`);
		}

		// Origin
		if (entry.origin) {
			parts.push(`**Origin:** ${entry.origin}\n`);
		}

		// Script
		if (entry.script) {
			parts.push(`**Script:** ${entry.script}\n`);
		}

		// Typical Speakers
		if (entry.typicalSpeakers && entry.typicalSpeakers.length > 0) {
			const speakers = entry.typicalSpeakers.map(s => this._renderString(s)).join(", ");
			parts.push(`**Typical Speakers:** ${speakers}\n`);
		}

		// Description (if exists)
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
	 * Format deity content
	 */
	_formatDeity(entry) {
		const parts = [];

		// Title
		parts.push(`# ${entry.name}\n`);

		// Title/epithet
		if (entry.title) {
			parts.push(`*${entry.title}*\n`);
		}

		// Alignment
		if (entry.alignment) {
			const alignmentStr = Parser.alignmentListToFull(entry.alignment);
			parts.push(`**Alignment:** ${alignmentStr}\n`);
		}

		// Domains
		if (entry.domains && entry.domains.length > 0) {
			parts.push(`**Domains:** ${entry.domains.join(", ")}\n`);
		}

		// Pantheon
		if (entry.pantheon) {
			parts.push(`**Pantheon:** ${entry.pantheon}\n`);
		}

		// Province
		if (entry.province) {
			parts.push(`**Province:** ${entry.province}\n`);
		}

		// Symbol
		if (entry.symbol) {
			parts.push(`**Symbol:** ${entry.symbol}\n`);
		}

		// Description
		if (entry.entries) {
			parts.push("\n" + this._renderEntries(entry.entries));
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
	 * Format object content
	 */
	_formatObject(entry) {
		const parts = [];

		// Title
		parts.push(`# ${entry.name}\n`);

		// Size and Type
		const typeInfo = [];
		if (entry.size) {
			const sizeMap = {T: "Tiny", S: "Small", M: "Medium", L: "Large", H: "Huge", G: "Gargantuan"};
			const sizes = Array.isArray(entry.size) ? entry.size : [entry.size];
			typeInfo.push(sizes.map(s => sizeMap[s] || s).join(" or "));
		}
		if (entry.objectType) {
			const typeMap = {
				'SW': 'siege weapon',
				'SPC': 'space object',
				'VEH': 'vehicle'
			};
			typeInfo.push(typeMap[entry.objectType] || entry.objectType);
		}
		if (typeInfo.length) {
			parts.push(`*${typeInfo.join(" ")}*\n`);
		}

		// Stats
		const stats = [];
		if (entry.ac !== undefined) {
			const ac = typeof entry.ac === 'object' ? entry.ac.ac : entry.ac;
			stats.push(`**Armor Class** ${ac}`);
		}
		if (entry.hp !== undefined) {
			const hp = typeof entry.hp === 'object' ? entry.hp.hp : entry.hp;
			stats.push(`**Hit Points** ${hp}`);
		}
		if (stats.length) {
			parts.push(stats.join("  \n") + "\n");
		}

		// Immunities
		if (entry.immune && entry.immune.length > 0) {
			parts.push(`**Damage Immunities** ${entry.immune.join(", ")}\n`);
		}

		// Description
		if (entry.entries) {
			parts.push(this._renderEntries(entry.entries) + "\n");
		}

		// Actions
		if (entry.actionEntries && entry.actionEntries.length > 0) {
			parts.push("## Actions\n");
			for (const action of entry.actionEntries) {
				if (action.name) {
					parts.push(`### ${this._renderString(action.name)}\n`);
				}
				if (action.entries) {
					parts.push(this._renderEntries(action.entries) + "\n");
				}
			}
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
	 * Format psionic entry content
	 */
	_formatPsionic(entry) {
		const parts = [];

		// Title
		parts.push(`# ${entry.name}\n`);

		// Type and Order (for disciplines)
		const typeInfo = [];
		if (entry.type) {
			const typeMap = {'D': 'Psionic Discipline', 'T': 'Psionic Talent'};
			typeInfo.push(typeMap[entry.type] || entry.type);
		}
		if (entry.order) {
			typeInfo.push(`(${entry.order})`);
		}
		if (typeInfo.length) {
			parts.push(`*${typeInfo.join(" ")}*\n`);
		}

		// Description
		if (entry.entries) {
			parts.push(this._renderEntries(entry.entries) + "\n");
		}

		// Psychic Focus (only for disciplines)
		if (entry.focus) {
			parts.push(`## Psychic Focus\n`);
			parts.push(`${this._renderString(entry.focus)}\n`);
		}

		// Modes (only for disciplines)
		if (entry.modes && entry.modes.length > 0) {
			parts.push(`## Discipline Modes\n`);
			for (const mode of entry.modes) {
				if (mode.name) {
					// Mode name with cost
					let modeName = mode.name;
					if (mode.cost) {
						const costStr = mode.cost.min === mode.cost.max
							? `${mode.cost.min} psi`
							: `${mode.cost.min}-${mode.cost.max} psi`;
						modeName += ` (${costStr})`;
					}
					parts.push(`### ${this._renderString(modeName)}\n`);
				}

				// Concentration
				if (mode.concentration) {
					const duration = mode.concentration.duration;
					const unit = mode.concentration.unit;
					parts.push(`*Concentration, up to ${duration} ${unit}*\n`);
				}

				// Mode description
				if (mode.entries) {
					parts.push(this._renderEntries(mode.entries) + "\n");
				}
			}
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
	 * Format reward entry content
	 */
	_formatReward(entry) {
		const parts = [];

		// Title
		parts.push(`# ${entry.name}\n`);

		// Reward type
		if (entry.type) {
			parts.push(`*${entry.type}*\n`);
		}

		// Description
		if (entry.entries) {
			parts.push(this._renderEntries(entry.entries) + "\n");
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
	 * Format table entry content
	 */
	_formatTable(entry) {
		const parts = [];

		// Title
		parts.push(`# ${entry.name}\n`);

		// Caption (if different from name)
		if (entry.caption && entry.caption !== entry.name) {
			parts.push(`*${entry.caption}*\n`);
		}

		// Render the table
		if (entry.colLabels && entry.rows) {
			// Header row
			const headers = entry.colLabels.join(" | ");
			parts.push(`| ${headers} |`);

			// Separator row
			const separators = entry.colLabels.map(() => "---").join(" | ");
			parts.push(`| ${separators} |`);

			// Data rows
			for (const row of entry.rows) {
				// Process each cell through _renderString to convert tags to wikilinks
				const cells = row.map(cell => {
					if (typeof cell === 'string') {
						return this._renderString(cell);
					} else if (typeof cell === 'object' && cell.type === 'cell') {
						// Handle cell objects (used for complex cells with entries)
						if (cell.entry) {
							return this._renderString(cell.entry);
						} else if (cell.entries) {
							return this._renderEntries(cell.entries);
						}
					}
					return String(cell);
				});
				parts.push(`| ${cells.join(" | ")} |`);
			}

			parts.push(""); // Empty line after table
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
	 * Format vehicle entry content
	 */
	_formatVehicle(entry) {
		const parts = [];

		// Title
		parts.push(`# ${entry.name}\n`);

		// Vehicle type and size
		const typeInfo = [];
		if (entry.vehicleType) {
			const vehicleTypeMap = {
				'SHIP': 'Ship',
				'SPELLJAMMER': 'Spelljammer',
				'INFWAR': 'Infernal War Machine',
				'CREATURE': 'Creature',
				'OBJECT': 'Object',
				'ELEMENTAL_AIRSHIP': 'Elemental Airship'
			};
			typeInfo.push(vehicleTypeMap[entry.vehicleType] || entry.vehicleType);
		}
		if (entry.size) {
			const sizeMap = {T: "Tiny", S: "Small", M: "Medium", L: "Large", H: "Huge", G: "Gargantuan"};
			const sizes = Array.isArray(entry.size) ? entry.size : [entry.size];
			typeInfo.push(sizes.map(s => sizeMap[s] || s).join(" or "));
		}
		if (typeInfo.length) {
			parts.push(`*${typeInfo.join(", ")}*\n`);
		}

		// Dimensions and pace (for ships)
		const shipInfo = [];
		if (entry.dimensions) {
			shipInfo.push(`**Dimensions:** ${entry.dimensions.join(" × ")}`);
		}
		if (entry.pace !== undefined) {
			shipInfo.push(`**Travel Pace:** ${entry.pace} miles per hour`);
		}
		// Crew capacity (capCreature for infernal war machines, capCrew for ships)
		if (entry.capCreature !== undefined) {
			shipInfo.push(`**Crew Capacity:** ${entry.capCreature}`);
		}
		// Cargo capacity - tons for ships, pounds for infernal war machines
		if (entry.capCargo !== undefined) {
			const isShip = entry.vehicleType === 'SHIP' || entry.vehicleType === 'SPELLJAMMER';
			const unit = isShip ? 'tons' : 'lb.';
			shipInfo.push(`**Cargo Capacity:** ${entry.capCargo} ${unit}`);
		}
		if (shipInfo.length) {
			parts.push(shipInfo.join("  \n") + "\n");
		}

		// Ability scores (for ships/creatures)
		if (entry.str !== undefined || entry.dex !== undefined || entry.con !== undefined) {
			const abilities = [];
			if (entry.str !== undefined) abilities.push(`**STR** ${entry.str}`);
			if (entry.dex !== undefined) abilities.push(`**DEX** ${entry.dex}`);
			if (entry.con !== undefined) abilities.push(`**CON** ${entry.con}`);
			if (entry.int !== undefined) abilities.push(`**INT** ${entry.int}`);
			if (entry.wis !== undefined) abilities.push(`**WIS** ${entry.wis}`);
			if (entry.cha !== undefined) abilities.push(`**CHA** ${entry.cha}`);
			if (abilities.length) {
				parts.push(abilities.join(", ") + "\n");
			}
		}

		// Condition immunities
		if (entry.conditionImmune && entry.conditionImmune.length > 0) {
			parts.push(`**Condition Immunities** ${entry.conditionImmune.join(", ")}\n`);
		}

		// Description from entries
		if (entry.entries) {
			parts.push(this._renderEntries(entry.entries) + "\n");
		}

		// Hull (for ships)
		if (entry.hull) {
			parts.push(`## Hull\n`);
			const hullStats = [];
			if (entry.hull.ac !== undefined) hullStats.push(`**Armor Class:** ${entry.hull.ac}`);
			if (entry.hull.hp !== undefined) hullStats.push(`**Hit Points:** ${entry.hull.hp}`);
			if (entry.hull.dt !== undefined) hullStats.push(`**Damage Threshold:** ${entry.hull.dt}`);
			parts.push(hullStats.join("  \n") + "\n");
		}

		// Control (for ships - helm)
		if (entry.control && entry.control.length > 0) {
			parts.push(`## Control\n`);
			for (const ctrl of entry.control) {
				if (ctrl.name) {
					parts.push(`### ${this._renderString(ctrl.name)}\n`);
				}
				const ctrlStats = [];
				if (ctrl.ac !== undefined) ctrlStats.push(`**Armor Class:** ${ctrl.ac}`);
				if (ctrl.hp !== undefined) ctrlStats.push(`**Hit Points:** ${ctrl.hp}`);
				if (ctrlStats.length) {
					parts.push(ctrlStats.join("  \n") + "\n");
				}
				if (ctrl.entries) {
					parts.push(this._renderEntries(ctrl.entries) + "\n");
				}
			}
		}

		// Movement (for ships - oars, sails)
		if (entry.movement && entry.movement.length > 0) {
			parts.push(`## Movement\n`);
			for (const move of entry.movement) {
				if (move.name) {
					parts.push(`### ${this._renderString(move.name)}\n`);
				}
				const moveStats = [];
				if (move.ac !== undefined) moveStats.push(`**Armor Class:** ${move.ac}`);
				if (move.hp !== undefined) moveStats.push(`**Hit Points:** ${move.hp}`);
				if (move.hpNote) moveStats.push(`(${move.hpNote})`);
				if (moveStats.length) {
					parts.push(moveStats.join(" ") + "\n");
				}
				if (move.speed) {
					for (const spd of move.speed) {
						if (spd.entries) {
							parts.push(`**Speed (${spd.mode}):** ${spd.entries.join(", ")}\n`);
						}
					}
				}
				if (move.entries) {
					parts.push(this._renderEntries(move.entries) + "\n");
				}
			}
		}

		// Weapons (for ships - ballistas, mangonels, naval ram)
		if (entry.weapon && entry.weapon.length > 0) {
			parts.push(`## Weapons\n`);
			for (const weapon of entry.weapon) {
				if (weapon.name) {
					let weaponName = this._renderString(weapon.name);
					if (weapon.count && weapon.count > 1) {
						weaponName = `${weapon.count} ${weaponName}`;
					}
					parts.push(`### ${weaponName}\n`);
				}
				const weaponStats = [];
				if (weapon.ac !== undefined) weaponStats.push(`**Armor Class:** ${weapon.ac}`);
				if (weapon.hp !== undefined) weaponStats.push(`**Hit Points:** ${weapon.hp}`);
				if (weapon.dt !== undefined) weaponStats.push(`**Damage Threshold:** ${weapon.dt}`);
				if (weaponStats.length) {
					parts.push(weaponStats.join("  \n") + "\n");
				}
				if (weapon.entries) {
					parts.push(this._renderEntries(weapon.entries) + "\n");
				}
			}
		}

		// Actions
		if (entry.action) {
			parts.push(`## Actions\n`);
			parts.push(this._renderEntries(entry.action) + "\n");
		}

		// Traits (for infernal war machines)
		if (entry.trait && entry.trait.length > 0) {
			parts.push(`## Traits\n`);
			for (const trait of entry.trait) {
				if (trait.name) {
					parts.push(`### ${this._renderString(trait.name)}\n`);
				}
				if (trait.entries) {
					parts.push(this._renderEntries(trait.entries) + "\n");
				}
			}
		}

		// Action Stations (for infernal war machines)
		if (entry.actionStation && entry.actionStation.length > 0) {
			parts.push(`## Action Stations\n`);
			for (const station of entry.actionStation) {
				if (station.name) {
					parts.push(`### ${this._renderString(station.name)}\n`);
				}
				if (station.entries) {
					parts.push(this._renderEntries(station.entries) + "\n");
				}
			}
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
	 * Render a string that may contain tags like {@recharge 5}
	 */
	_renderString(str) {
		if (!str) return "";
		const textStack = [""];
		this.renderer.recursiveRender(str, textStack, {depth: 0});
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

	/**
	 * Look up legendary group data for a monster
	 */
	_getLegendaryGroup(legendaryGroupRef) {
		if (!legendaryGroupRef || !this.legendaryGroupMap) {
			return null;
		}
		const key = `${legendaryGroupRef.name}|${legendaryGroupRef.source}`.toLowerCase();
		return this.legendaryGroupMap.get(key);
	}

	/**
	 * Calculate initiative bonus for a monster
	 * Based on Renderer.monster.getInitiativeBonusNumber from render.js
	 */
	_getInitiativeBonus(mon) {
		// If no initiative field and no dex, or dex is special, return null
		if (mon.initiative == null && (mon.dex == null || (typeof mon.dex === "object" && mon.dex.special))) {
			return null;
		}
		// If no initiative field, use DEX modifier
		if (mon.initiative == null) {
			return Parser.getAbilityModNumber(mon.dex);
		}
		// If initiative is a direct number, use it
		if (typeof mon.initiative === "number") {
			return mon.initiative;
		}
		// If initiative is not an object, return null
		if (typeof mon.initiative !== "object") {
			return null;
		}
		// If initiative object has a direct initiative value, use it
		if (typeof mon.initiative.initiative === "number") {
			return mon.initiative.initiative;
		}
		// Calculate with proficiency bonus (expertise)
		if (mon.dex == null) return null;
		const profBonus = mon.initiative.proficiency
			? mon.initiative.proficiency * Parser.crToPb(typeof mon.cr === "object" ? mon.cr.cr : mon.cr)
			: 0;
		return Parser.getAbilityModNumber(mon.dex) + profBonus;
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

		// Load legendary groups data (for lair actions, regional effects)
		this.legendaryGroups = null;
		try {
			const legendaryPath = path.join(this.dataDir, "bestiary", "legendarygroups.json");
			if (fs.existsSync(legendaryPath)) {
				const data = readJson(legendaryPath);
				this.legendaryGroups = data.legendaryGroup || [];
				this.log("Loaded legendary groups data");
			}
		} catch (e) {
			console.warn("Failed to load legendary groups, lair actions/regional effects won't be added:", e.message);
		}

		// Initialize generators with loaded data
		this.frontmatterGenerator = new FrontmatterGenerator(this.spellClassLookup);
		this.formatter = new MarkdownFormatter(this.renderer, this.legendaryGroups);
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
		subrace: {dir: "races"},
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
				if (entryType === "class" && !entry.classFeatures) {
					this.log(`  Skipping ${entry.name} from ${entry.source}: no classFeatures field (likely foundry data)`);
					continue;
				}
				if (entryType === "subclass" && !entry.subclassFeatures) {
					this.log(`  Skipping ${entry.name} from ${entry.source}: no subclassFeatures field (likely foundry data)`);
					continue;
				}
				if (entryType === "feat" && !entry.entries) {
					this.log(`  Skipping ${entry.name} from ${entry.source}: no entries field`);
					continue;
				}
				if ((entryType === "race" || entryType === "subrace") && !entry.entries) {
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

		// Skip _copy reference entries (these are just pointers to reprints)
		if (entry._copy) {
			this.log(`  Skipping ${entry.name} from ${entry.source}: _copy reference`);
			this.stats.skipped++;
			return;
		}

		// Skip entries without required content fields
		// (e.g., foundry-*.json files often have metadata-only entries)
		if (entryType === "class" && !entry.classFeatures) {
			this.log(`  Skipping ${entry.name} from ${entry.source}: no classFeatures field (likely foundry data)`);
			this.stats.skipped++;
			return;
		}
		if (entryType === "subclass" && !entry.subclassFeatures) {
			this.log(`  Skipping ${entry.name} from ${entry.source}: no subclassFeatures field (likely foundry data)`);
			this.stats.skipped++;
			return;
		}
		if (entryType === "feat" && !entry.entries) {
			this.log(`  Skipping ${entry.name} from ${entry.source}: no entries field`);
			this.stats.skipped++;
			return;
		}
		if ((entryType === "race" || entryType === "subrace") && !entry.entries) {
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
		// For subraces, include the base race name
		let displayName = entry.name;
		if (entryType === "subrace" && entry.raceName) {
			displayName = `${entry.name} ${entry.raceName}`;
		}
		const filename = this._sanitizeFilename(`${displayName} (${entry.source || "Unknown"}).md`);
		const outputPath = path.join(this.outputDir, resourceInfo.dir, filename);

		// Ensure directory exists
		const outputDirPath = path.dirname(outputPath);
		if (!fs.existsSync(outputDirPath)) {
			fs.mkdirSync(outputDirPath, {recursive: true});
		}

		// Generate frontmatter
		const frontmatter = this.frontmatterGenerator.generate(entry, entryType, entryHash);

		// Generate markdown content
		// For classes and subclasses, pass the full file data for accessing features
		let markdown;
		if (entryType === "class" || entryType === "subclass") {
			const fullData = readJson(sourceFile);
			markdown = this.formatter.format(entry, entryType, frontmatter, fullData);
		} else {
			markdown = this.formatter.format(entry, entryType, frontmatter);
		}

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
