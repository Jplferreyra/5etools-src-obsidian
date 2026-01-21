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
		this._itemLookup = null;  // Map of item name (lowercase) -> source
	}

	/**
	 * Set the item lookup map for resolving sources
	 */
	setItemLookup(itemLookup) {
		this._itemLookup = itemLookup;
		return this;
	}

	static TAG_TO_DIR_MAP = {
		"@spell": "Spells",
		"@item": "Items",
		"@creature": "Bestiary",
		"@monster": "Bestiary",
		"@background": "Backgrounds",
		"@class": "Classes",  // Note: actual path determined dynamically for hierarchy
		"@subclass": "Classes",  // Note: actual path determined dynamically for hierarchy
		"@race": "Races",
		"@feat": "Feats",
		"@condition": "Rules/Conditions",
		"@disease": "Rules/Conditions",
		"@deity": "Deities",
		"@action": "Actions",
		"@vehicle": "Vehicles",
		"@object": "Objects",
		"@optionalfeature": "Optional Features",
		"@reward": "Rewards",
		"@psionic": "Psionics",
		"@variantrule": "Rules/Variant Rules",
		"@table": "Tables",
		"@language": "Languages",
		"@trap": "Traps Hazards",
		"@hazard": "Traps Hazards",
		"@cult": "Cults Boons",
		"@boon": "Cults Boons",
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
		let source = parts[1];
		const displayText = parts[2] || name;

		// For @item tags, look up to get source and type (item vs magicvariant)
		let itemType = null;
		let properName = name;
		if (tag === "@item" && this._itemLookup) {
			const lookupKey = name.toLowerCase();
			const lookupResult = this._itemLookup.get(lookupKey);
			if (lookupResult) {
				if (!source) source = lookupResult.source;
				itemType = lookupResult.type;
				properName = lookupResult.name; // Use proper casing from lookup
			}
		}

		// Default source if still not found
		if (!source) {
			source = tag === "@item" ? "DMG" : "PHB";
		}

		// Get the resource directory - special handling for magic variants
		let resourceDir = ObsidianMarkdownRenderer.TAG_TO_DIR_MAP[tag];
		if (tag === "@item" && itemType === "magicvariant") {
			resourceDir = "Items/Magic Variants";
		}

		// Clean the name for use in filename (use properName to preserve casing)
		const cleanName = this._cleanName(properName);
		const cleanSource = source.toUpperCase();

		// Generate wikilink path - special handling for class hierarchy
		const filename = `${cleanName} - ${cleanSource}`;
		let wikilinkPath;

		if (tag === "@class") {
			// Classes are in: Classes/{ClassName}/{ClassName} - {Source}.md
			wikilinkPath = `Classes/${cleanName}/${filename}`;
		} else if (tag === "@subclass") {
			// Subclasses need parent class info which we don't have in the tag
			// Use just the filename - Obsidian will find it by name
			wikilinkPath = filename;
		} else {
			// Standard path for other resource types
			wikilinkPath = `${resourceDir}/${filename}`;
		}

		const wikilink = `[[${wikilinkPath}\\|${filename}]]`;
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
				return {...base, statblock: "inline", ...this._generateMonster(entry)};
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
			case "recipe":
				return {...base, ...this._generateRecipe(entry)};
			default:
				return base;
		}
	}

	/**
	 * Generate base frontmatter common to all entries
	 */
	_generateBase(entry, entryType, entryHash) {
		const tags = this._generateTags(entry, entryType);

		// Special handling for itemProperty where name is nested
		let name = entry.name || "Unknown";
		if (entryType === "itemProperty") {
			name = entry.entries?.[0]?.name || "Unknown Property";
		}

		// Special handling for magicvariant where source is in inherits
		let source = entry.source;
		if (entryType === "magicvariant" && entry.inherits?.source) {
			source = entry.inherits.source;
		}

		return {
			name,
			source: source || "Unknown",
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

		// Get source - special handling for magicvariant
		let source = entry.source;
		if (entryType === "magicvariant" && entry.inherits?.source) {
			source = entry.inherits.source;
		}

		if (source) {
			tags.push(`dnd5e/source-${source.toLowerCase()}`);
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

		if (entryType === "optionalfeature" && entry.featureType) {
			// Add tags for each feature type
			entry.featureType.forEach(typeCode => {
				const decoded = this._decodeFeatureType(typeCode);
				// Create kebab-case tag from decoded name
				const tagName = decoded.toLowerCase().replace(/[() ]/g, "-").replace(/--+/g, "-").replace(/^-|-$/g, "");
				tags.push(`dnd5e/optionalfeature/${tagName}`);
			});
		}

		return tags;
	}

	/**
	 * Decode optional feature type codes
	 * Returns human-readable feature type names
	 */
	_decodeFeatureType(typeCode) {
		// Handle codes with colons (e.g., FS:F, MV:B)
		const parts = typeCode.split(":");

		const baseTypeMap = {
			"AI": "Artificer Infusion",
			"AS": "Arcane Shot",
			"ED": "Elemental Discipline",
			"EI": "Eldritch Invocation",
			"FS": "Fighting Style",
			"MM": "Metamagic",
			"MV": "Maneuver",
			"PB": "Pact Boon",
			"RN": "Rune",
			"RP": "Rune Power"
		};

		const subTypeMap = {
			"B": "Barbarian",
			"F": "Fighter",
			"P": "Paladin",
			"R": "Ranger"
		};

		const baseType = baseTypeMap[parts[0]] || parts[0];

		// If there's a subtype, append it
		if (parts.length === 2 && subTypeMap[parts[1]]) {
			return `${baseType} (${subTypeMap[parts[1]]})`;
		}

		return baseType;
	}

	/**
	 * Generate aliases for the entry
	 */
	_generateAliases(entry, entryType) {
		const aliases = [];

		// Add "Name - SOURCE" format as alias (matches filename)
		if (entry.name && entry.source) {
			aliases.push(`${entry.name} - ${entry.source}`);
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

	_generateRecipe(recipe) {
		const fm = {};

		// Misc tags (alcohol, feast, etc.)
		if (recipe.miscTags && recipe.miscTags.length > 0) {
			fm.miscTags = recipe.miscTags;
		}

		return fm;
	}
}

/**
 * Formats markdown content for different resource types
 */
class MarkdownFormatter {
	constructor(renderer, legendaryGroups = [], magicVariantLookup = null, itemGroupLookup = null, itemTypeLookup = null, monsterFluffLookup = null) {
		this.renderer = renderer;
		this.legendaryGroups = legendaryGroups;
		this.magicVariantLookup = magicVariantLookup;
		this.itemGroupLookup = itemGroupLookup;
		this.itemTypeLookup = itemTypeLookup; // Maps "abbr|source" -> {name, source, abbreviation, items[]}
		this.monsterFluffLookup = monsterFluffLookup; // Maps "name|source" -> image path

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
			case "sense":
				content = this._formatSense(entry);
				break;
			case "status":
				content = this._formatStatus(entry);
				break;
			case "itemProperty":
				content = this._formatItemProperty(entry);
				break;
			case "itemMastery":
				content = this._formatItemMastery(entry);
				break;
			case "vehicleUpgrade":
				content = this._formatVehicleUpgrade(entry);
				break;
			case "facility":
				content = this._formatFacility(entry);
				break;
			case "recipe":
				content = this._formatRecipe(entry);
				break;
			case "charoption":
				content = this._formatCharoption(entry);
				break;
			case "magicvariant":
				content = this._formatMagicVariant(entry);
				break;
			case "itemGroup":
				content = this._formatItemGroup(entry);
				break;
			case "itemType":
				content = this._formatItemType(entry);
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

		// 1. Fantasy Statblocks codeblock
		parts.push("```statblock");
		parts.push(this._generateStatblockYaml(monster));
		parts.push("```\n");

		// 2. Title
		parts.push(`# ${monster.name}\n`);

		// 3. Size, type, alignment
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

		// 4. Horizontal rule
		parts.push("---\n");

		// 5. Stats block
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

		// 6. Ability scores table
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

		// 7. Additional stats (saves, skills, etc.)
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

		// 8. Horizontal rule before traits
		parts.push("---\n");

		// 9. Traits (inline format, no section header)
		if (monster.trait && monster.trait.length) {
			for (const trait of monster.trait) {
				parts.push(this._formatTraitInline(trait) + "\n");
			}
		}

		// 10. Spellcasting (inline format)
		if (monster.spellcasting && monster.spellcasting.length) {
			for (const sc of monster.spellcasting) {
				const name = sc.name || "Spellcasting";
				let desc = "";
				if (sc.headerEntries) {
					desc += this._renderEntries(sc.headerEntries);
				}
				if (sc.spells) {
					// Format spell list
					const spellParts = [];
					for (const [level, spellData] of Object.entries(sc.spells)) {
						if (spellData.spells && spellData.spells.length) {
							const levelStr = level === "0" ? "Cantrips" : `${level}${this._getOrdinalSuffix(parseInt(level))} level`;
							const slots = spellData.slots ? ` (${spellData.slots} slots)` : "";
							// Process each spell through _renderString to convert {@spell} tags to wikilinks
							const spellList = spellData.spells.map(spell => this._renderString(spell)).join(", ");
							spellParts.push(`**${levelStr}${slots}:** ${spellList}`);
						}
					}
					if (spellParts.length) {
						desc += "\n" + spellParts.join("\n");
					}
				}
				if (sc.footerEntries) {
					desc += "\n" + this._renderEntries(sc.footerEntries);
				}
				parts.push(`***${name}.*** ${desc.trim()}\n`);
			}
		}

		// 11. Actions
		if (monster.action && monster.action.length) {
			parts.push("## Actions\n");
			for (const action of monster.action) {
				parts.push(this._formatTraitInline(action) + "\n");
			}
		}

		// 12. Bonus Actions
		if (monster.bonus && monster.bonus.length) {
			parts.push("## Bonus Actions\n");
			for (const bonus of monster.bonus) {
				parts.push(this._formatTraitInline(bonus) + "\n");
			}
		}

		// 13. Reactions
		if (monster.reaction && monster.reaction.length) {
			parts.push("## Reactions\n");
			for (const reaction of monster.reaction) {
				parts.push(this._formatTraitInline(reaction) + "\n");
			}
		}

		// 14. Legendary Actions
		if (monster.legendary && monster.legendary.length) {
			parts.push("## Legendary Actions\n");

			// Add legendary actions header text (standard D&D 5e format)
			const actionCount = monster.legendaryActions || 3;
			const creatureName = monster.isNamedCreature || monster.isNpc ? monster.name : `the ${monster.name.toLowerCase()}`;
			parts.push(`${creatureName.charAt(0).toUpperCase() + creatureName.slice(1)} can take ${actionCount} legendary actions, choosing from the options below. Only one legendary action option can be used at a time and only at the end of another creature's turn. ${creatureName.charAt(0).toUpperCase() + creatureName.slice(1)} regains spent legendary actions at the start of its turn.\n`);

			for (const legendary of monster.legendary) {
				parts.push(this._formatTraitInline(legendary) + "\n");
			}
		}

		// 15. Mythic Actions
		if (monster.mythic && monster.mythic.length) {
			parts.push("## Mythic Actions\n");
			for (const mythic of monster.mythic) {
				parts.push(this._formatTraitInline(mythic) + "\n");
			}
		}

		// 16. Lair Actions (from monster data or legendary group)
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

		// 17. Regional Effects (from monster data or legendary group)
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

		// 18. Source
		if (monster.source) {
			parts.push("---\n");
			const sourceFull = Parser.sourceJsonToFull(monster.source);
			const pageStr = monster.page ? `, page ${monster.page}` : "";
			parts.push(`**Source:** *${sourceFull}*${pageStr}`);
		}

		// 19. Image (at the end)
		const imageUrl = this._getMonsterImageUrl(monster);
		if (imageUrl) {
			parts.push(`\n\n![${monster.name}](${imageUrl})`);
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
						const filename = `${name} - ${source}`;
						return `[[Rules/Weapon Properties/${filename}\\|${filename}]]`;
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
					const filename = `${masteryName} - ${source}`;
					return `[[Rules/Variant Rules/${filename}\\|${filename}]]`;
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
						features.push(`[[#${cls.subclassTitle}\\|${displayName}]]`);
					} else {
						features.push(displayName);
					}
				} else {
					features.push(`[[#${displayName}\\|${displayName}]]`);
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
							parts.push(`- [[Classes/${cls.name}/Subclasses/${sc.name} - ${sc.source}\\|${sc.name}]]\n`);
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
							// Expand any refClassFeature entries before rendering
							const expandedEntries = this._expandFeatureRefs(featureData.entries, classData);
							parts.push(this._renderEntries(expandedEntries) + "\n");
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
			parts.push(`**Class:** [[Classes/${subclass.className}/${subclass.className} - ${subclass.classSource}\\|${subclass.className}]]\n`);
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
				parts.push(`| ${level} | [[#${displayName}\\|${displayName}]] |`);
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
						// Expand any refSubclassFeature entries before rendering
						const expandedEntries = this._expandFeatureRefs(featureData.entries, classData);
						parts.push(this._renderEntries(expandedEntries) + "\n");
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
	 * Expand feature references (refSubclassFeature, refClassFeature) in entries
	 * Replaces reference entries with the actual feature content
	 */
	_expandFeatureRefs(entries, classData) {
		if (!entries || !Array.isArray(entries)) return entries;

		const expanded = [];

		for (const entry of entries) {
			// Handle refSubclassFeature
			if (typeof entry === "object" && entry.type === "refSubclassFeature") {
				const refString = entry.subclassFeature;
				const feature = this._findSubclassFeature(refString, classData);

				if (feature) {
					// Add the feature as a nested heading with its content
					expanded.push({
						type: "entries",
						name: feature.name,
						entries: feature.entries || []
					});
				}
			}
			// Handle refClassFeature
			else if (typeof entry === "object" && entry.type === "refClassFeature") {
				const refString = entry.classFeature;
				const feature = this._findClassFeature(refString, classData);

				if (feature) {
					// Add the feature as a nested heading with its content
					expanded.push({
						type: "entries",
						name: feature.name,
						entries: feature.entries || []
					});
				}
			}
			// Keep other entries as-is
			else {
				expanded.push(entry);
			}
		}

		return expanded;
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
	 * Generate a block ID from table name for Dice Roller plugin
	 */
	_generateTableBlockId(tableName) {
		return tableName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "");
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

			// Add block ID for Dice Roller plugin
			const blockId = this._generateTableBlockId(entry.name);
			parts.push(`^${blockId}`);
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
	 * Format sense entry (Darkvision, Blindsight, etc.)
	 */
	_formatSense(entry) {
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
	 * Format status entry (Bloodied, Concentration, Surprised)
	 */
	_formatStatus(entry) {
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
	 * Format weapon property entry (Finesse, Two-Handed, Versatile, etc.)
	 */
	_formatItemProperty(entry) {
		const parts = [];

		// Title - use the name from nested entries
		const propertyName = entry.entries?.[0]?.name || entry.name || "Unknown Property";
		parts.push(`# ${propertyName}\n`);

		// Abbreviation
		if (entry.abbreviation) {
			parts.push(`**Abbreviation:** ${entry.abbreviation}\n`);
		}

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
	 * Format weapon mastery entry (Cleave, Graze, Push, etc.)
	 */
	_formatItemMastery(entry) {
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
	 * Format vehicle upgrade entry
	 */
	_formatVehicleUpgrade(entry) {
		const parts = [];

		// Title
		parts.push(`# ${entry.name}\n`);

		// Upgrade Type
		if (entry.upgradeType && entry.upgradeType.length > 0) {
			const decodedTypes = entry.upgradeType.map(type => this._decodeVehicleUpgradeType(type));
			parts.push(`**Upgrade Type:** ${decodedTypes.join(", ")}\n`);
		}

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
	 * Decode vehicle upgrade type codes
	 * Format: PREFIX:SUFFIX where PREFIX is vehicle type and SUFFIX is upgrade category
	 */
	_decodeVehicleUpgradeType(typeCode) {
		const parts = typeCode.split(":");
		if (parts.length !== 2) return typeCode;

		const vehicleTypes = {
			"IWM": "Infernal War Machine",
			"SHP": "Ship"
		};

		const upgradeCategories = {
			"A": "Armor",
			"F": "Figurehead",
			"G": "Gadget",
			"H": "Hull",
			"M": "Movement",
			"O": "Other",
			"W": "Weapon"
		};

		const vehicleType = vehicleTypes[parts[0]] || parts[0];
		const upgradeCategory = upgradeCategories[parts[1]] || parts[1];

		return `${vehicleType} - ${upgradeCategory}`;
	}

	/**
	 * Format facility entry (Bastion facilities)
	 */
	_formatFacility(entry) {
		const parts = [];

		// Title
		parts.push(`# ${entry.name}\n`);

		// Facility Type
		if (entry.facilityType) {
			parts.push(`**Type:** ${entry.facilityType}\n`);
		}

		// Level
		if (entry.level) {
			parts.push(`**Level:** ${entry.level}\n`);
		}

		// Space
		if (entry.space && entry.space.length > 0) {
			parts.push(`**Space:** ${entry.space.join(", ")}\n`);
		}

		// Prerequisites
		if (entry.prerequisite && entry.prerequisite.length > 0) {
			const prereqs = entry.prerequisite.map(prereq => {
				if (typeof prereq === "string") return prereq;
				if (prereq.facility) return `Facility: ${prereq.facility}`;
				if (prereq.level) return `Level ${prereq.level}+`;
				return JSON.stringify(prereq);
			});
			parts.push(`**Prerequisites:** ${prereqs.join(", ")}\n`);
		}

		// Hirelings
		if (entry.hirelings && entry.hirelings.length > 0) {
			const hirelingStrs = entry.hirelings.map(h => {
				if (h.exact !== undefined) return `${h.exact}`;
				if (h.min !== undefined && h.max !== undefined) return `${h.min}-${h.max}`;
				if (h.min !== undefined) return `${h.min}+`;
				if (h.max !== undefined) return `up to ${h.max}`;
				return "varies";
			});
			parts.push(`**Hirelings:** ${hirelingStrs.join(", ")}\n`);
		}

		// Orders
		if (entry.orders && entry.orders.length > 0) {
			const orderNames = entry.orders.map(order => {
				// Capitalize first letter
				return order.charAt(0).toUpperCase() + order.slice(1);
			});
			parts.push(`**Available Orders:** ${orderNames.join(", ")}\n`);
		}

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
	 * Replace amount placeholders in recipe entries
	 * Replaces {=amount1/v}, {=amount2/v}, etc. with actual values
	 */
	_replaceRecipeAmounts(text, item) {
		let result = text;

		// Replace amount1, amount2, etc.
		for (let i = 1; i <= 10; i++) {
			const amountKey = `amount${i}`;
			if (item[amountKey] !== undefined) {
				const placeholder = new RegExp(`\\{=amount${i}/v\\}`, 'g');
				result = result.replace(placeholder, item[amountKey]);
			}
		}

		return result;
	}

	/**
	 * Decode diet type code
	 */
	_decodeDietType(code) {
		const dietMap = {
			"V": "Vegetarian",
			"C": "Vegetarian (with dairy/eggs)",
			"X": "Contains meat"
		};
		return dietMap[code] || code;
	}

	/**
	 * Format recipe entry
	 */
	_formatRecipe(entry) {
		const parts = [];

		// Title
		parts.push(`# ${entry.name}\n`);

		// Aliases section
		if (entry.alias && entry.alias.length > 0) {
			parts.push(`**Also known as:** ${entry.alias.join(", ")}\n`);
		}

		// Type
		if (entry.type) {
			parts.push(`**Type:** ${entry.type}\n`);
		}

		// Diet type
		if (entry.diet) {
			parts.push(`**Diet:** ${this._decodeDietType(entry.diet)}\n`);
		}

		// Dish types
		if (entry.dishTypes && entry.dishTypes.length > 0) {
			const dishes = entry.dishTypes.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(", ");
			parts.push(`**Dish Type:** ${dishes}\n`);
		}

		// Allergen groups
		if (entry.allergenGroups && entry.allergenGroups.length > 0) {
			const allergens = entry.allergenGroups.map(a => a.charAt(0).toUpperCase() + a.slice(1)).join(", ");
			parts.push(`**Allergens:** ${allergens}\n`);
		}

		// Serves
		if (entry.serves) {
			let servesStr = "";
			if (entry.serves.exact) {
				servesStr = `${entry.serves.exact}`;
			} else if (entry.serves.min && entry.serves.max) {
				servesStr = `${entry.serves.min}-${entry.serves.max}`;
			}
			if (entry.serves.note) {
				servesStr += ` ${entry.serves.note}`;
			}
			if (servesStr) {
				parts.push(`**Serves:** ${servesStr}\n`);
			}
		}

		// Equipment
		if (entry.equipment && entry.equipment.length > 0) {
			parts.push(`## Equipment\n`);
			for (const equip of entry.equipment) {
				if (typeof equip === "string") {
					parts.push(`- ${equip}`);
				} else if (equip.entry) {
					// Replace amounts and render tags
					let text = this._replaceRecipeAmounts(equip.entry, equip);
					text = this._renderString(text);
					parts.push(`- ${text}`);
				}
			}
			parts.push("");
		}

		// Ingredients
		if (entry.ingredients && entry.ingredients.length > 0) {
			parts.push(`## Ingredients\n`);
			for (const ingredient of entry.ingredients) {
				if (typeof ingredient === "string") {
					parts.push(`- ${ingredient}`);
				} else if (ingredient.entry) {
					// Replace amounts and render tags
					let text = this._replaceRecipeAmounts(ingredient.entry, ingredient);
					text = this._renderString(text);
					parts.push(`- ${text}`);
				}
			}
			parts.push("");
		}

		// Instructions
		if (entry.instructions && entry.instructions.length > 0) {
			parts.push(`## Instructions\n`);
			for (let i = 0; i < entry.instructions.length; i++) {
				parts.push(`${i + 1}. ${entry.instructions[i]}\n`);
			}
		}

		// Description (entries)
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
	 * Decode option type codes for character options
	 */
	_decodeOptionType(typeCode) {
		const parts = typeCode.split(":");

		const baseTypeMap = {
			"CS": "Character Secret",
			"SG": "Supernatural Gift",
			"DG": "Dark Gift",
			"RF": "Background"
		};

		const baseType = baseTypeMap[parts[0]] || parts[0];

		// RF:B means "Reference Background" but we just call it "Background"
		return baseType;
	}

	/**
	 * Format character option entry
	 */
	_formatCharoption(entry) {
		const parts = [];

		// Title
		parts.push(`# ${entry.name}\n`);

		// Option Type
		if (entry.optionType && entry.optionType.length > 0) {
			const decodedTypes = entry.optionType.map(t => this._decodeOptionType(t)).join(", ");
			parts.push(`**Type:** ${decodedTypes}\n`);
		}

		// Prerequisites
		if (entry.prerequisite && entry.prerequisite.length > 0) {
			parts.push(`**Prerequisites:**\n`);
			for (const prereq of entry.prerequisite) {
				if (prereq.race) {
					const races = prereq.race.map(r => r.name).join(", ");
					parts.push(`- Race: ${races}`);
				}
				if (prereq.level) {
					parts.push(`- Level: ${prereq.level}`);
				}
				if (prereq.note) {
					parts.push(`- ${prereq.note}`);
				}
			}
			parts.push("");
		}

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
	 * Format magic variant entry (generic magic item variants)
	 */
	_formatMagicVariant(entry) {
		const parts = [];

		// Title
		parts.push(`# ${entry.name}\n`);

		// Type (what it requires/applies to)
		if (entry.requires && entry.requires.length > 0) {
			const requireTypes = entry.requires.map(r => r.type).filter(Boolean);
			if (requireTypes.length > 0) {
				// Create links to concept files
				const linkedTypes = requireTypes.map(typeKey => {
					// Try to look up the type name
					const lookupKey = typeKey.toLowerCase();
					const typeData = this.itemTypeLookup?.get(lookupKey);
					if (typeData) {
						const filename = `${typeData.name} - ${typeData.source}`;
						return `[[Rules/Concepts/${filename}\\|${typeData.name}]]`;
					}
					// Fallback to just the abbreviation if not found
					return typeKey;
				});
				parts.push(`**Applies To:** ${linkedTypes.join(", ")}\n`);
			}
		}

		// Rarity (from inherits)
		if (entry.inherits && entry.inherits.rarity) {
			parts.push(`**Rarity:** ${entry.inherits.rarity}\n`);
		}

		// Description
		if (entry.inherits && entry.inherits.entries) {
			parts.push(this._renderEntries(entry.inherits.entries));
		} else if (entry.entries) {
			parts.push(this._renderEntries(entry.entries));
		}

		// Source
		const source = entry.inherits?.source || entry.source;
		const page = entry.inherits?.page || entry.page;
		if (source) {
			const sourceFull = Parser.sourceJsonToFull(source);
			const pageStr = page ? `, page ${page}` : "";
			parts.push(`\n---\n**Source:** *${sourceFull}*${pageStr}`);
		}

		return parts.join("\n");
	}

	/**
	 * Format item group entry (groups of related items like "Sword of Answering")
	 */
	_formatItemGroup(entry) {
		const parts = [];

		// Title
		parts.push(`# ${entry.name}\n`);

		// Rarity
		if (entry.rarity) {
			parts.push(`**Rarity:** ${entry.rarity}\n`);
		}

		// Attunement
		if (entry.reqAttune) {
			const attuneText = typeof entry.reqAttune === "string" ? ` (${entry.reqAttune})` : "";
			parts.push(`**Requires Attunement**${attuneText}\n`);
		}

		// Type info
		if (entry.wondrous) {
			parts.push(`**Wondrous Item**\n`);
		}

		// Description
		if (entry.entries) {
			parts.push(this._renderEntries(entry.entries));
		}

		// List of items in the group - create links using {@item} tags
		if (entry.items && entry.items.length > 0) {
			parts.push(`\n## Variants\n`);
			for (const itemRef of entry.items) {
				// itemRef is usually in format "item name|source"
				// Use _renderString to process {@item} tag and create proper link
				const itemTag = `{@item ${itemRef}}`;
				const linkedItem = this._renderString(itemTag);
				parts.push(`- ${linkedItem}`);
			}
			parts.push("");
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
	 * Format item type entry (concepts like "Melee Weapon", "Heavy Armor", etc.)
	 */
	_formatItemType(entry) {
		const parts = [];

		// Title
		parts.push(`# ${entry.name}\n`);

		// Abbreviation
		if (entry.abbreviation) {
			parts.push(`**Abbreviation:** \`${entry.abbreviation}\`\n`);
		}

		// Entries/description
		if (entry.entries) {
			parts.push(this._renderEntries(entry.entries));
			parts.push("");
		}

		// List items of this type
		const typeKey = `${entry.abbreviation}|${entry.source}`.toLowerCase();
		const typeData = this.itemTypeLookup?.get(typeKey);
		if (typeData?.items && typeData.items.length > 0) {
			parts.push(`## Items\n`);
			for (const item of typeData.items) {
				// Create link to item
				const itemTag = `{@item ${item.name}|${item.source}}`;
				const linkedItem = this._renderString(itemTag);
				parts.push(`- ${linkedItem}`);
			}
			parts.push("");
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
	/**
	 * Escape a string for YAML - handles colons, quotes, and special characters
	 */
	_escapeYamlString(str) {
		if (str == null) return "";
		str = String(str);
		// If string contains special YAML characters, wrap in quotes
		if (str.includes(":") || str.includes("#") || str.includes("'") || str.includes('"') ||
			str.includes("\n") || str.startsWith("-") || str.startsWith("*") ||
			str.includes("{") || str.includes("}") || str.includes("[") || str.includes("]")) {
			// Escape double quotes and wrap in double quotes
			return `"${str.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
		}
		return str;
	}

	/**
	 * Format a trait/action inline: ***Name.*** Description
	 */
	_formatTraitInline(item) {
		if (!item) return "";
		const name = item.name ? this._renderString(item.name) : "";
		const desc = item.entries ? this._renderEntries(item.entries) : "";
		if (name && desc) {
			return `***${name}.*** ${desc}`;
		} else if (name) {
			return `***${name}.***`;
		} else if (desc) {
			return desc;
		}
		return "";
	}

	/**
	 * Unescape wikilinks for YAML - removes backslash before pipe
	 * Converts [[Path\\|Display]] to [[Path|Display]]
	 * Fantasy Statblocks needs unescaped wikilinks to render them
	 */
	_unescapeWikilinks(str) {
		if (!str) return "";
		// Remove backslash before pipe in wikilinks: [[path\|name]] -> [[path|name]]
		return str.replace(/\[\[([^\]]+)\\\|([^\]]+)\]\]/g, "[[$1|$2]]");
	}

	/**
	 * Strip Obsidian wikilinks from text for use in YAML
	 * Converts [[Path/To/Note|Display]] to Display
	 * Converts [[Path/To/Note]] to Note (last part of path)
	 * Handles nested brackets in paths like [[Path [with brackets]|Display]]
	 */
	_stripWikilinks(str) {
		if (!str) return "";
		// Handle wikilinks - need to match balanced brackets
		// Use a non-greedy approach: find [[ then match until ]]
		str = str.replace(/\[\[(.+?)\]\]/g, (match, content) => {
			// Check if there's a pipe for display text
			// Find the LAST pipe (in case path has pipes, though unlikely)
			const pipeIndex = content.lastIndexOf("|");
			if (pipeIndex !== -1) {
				// Return the display text (after the pipe)
				return content.substring(pipeIndex + 1);
			} else {
				// No pipe - extract note name from path
				const parts = content.split("/");
				return parts[parts.length - 1];
			}
		});
		return str;
	}

	/**
	 * Get the image URL for a monster from fluff data
	 */
	_getMonsterImageUrl(monster) {
		if (!this.monsterFluffLookup) return null;
		const key = `${monster.name}|${monster.source}`.toLowerCase();
		const imagePath = this.monsterFluffLookup.get(key);
		if (imagePath) {
			// Convert internal path to 5etools URL, escaping spaces
			const escapedPath = imagePath.replace(/ /g, "%20");
			return `https://5e.tools/img/${escapedPath}`;
		}
		return null;
	}

	/**
	 * Generate Fantasy Statblocks YAML for a monster
	 */
	_generateStatblockYaml(monster) {
		const lines = [];

		// Layout columns
		lines.push(`columns: 2`);
		lines.push(`columnWidth: 325`);
		lines.push(`columnHeight: 750`);

		// Image (from fluff data)
		const imageUrl = this._getMonsterImageUrl(monster);
		if (imageUrl) {
			lines.push(`image: ${imageUrl}`);
		}

		// Name
		lines.push(`name: ${this._escapeYamlString(monster.name)}`);

		// Size
		if (monster.size) {
			const sizeMap = {T: "Tiny", S: "Small", M: "Medium", L: "Large", H: "Huge", G: "Gargantuan"};
			const sizes = Array.isArray(monster.size) ? monster.size : [monster.size];
			lines.push(`size: ${sizeMap[sizes[0]] || sizes[0]}`);
		}

		// Type
		if (monster.type) {
			const type = typeof monster.type === "string" ? monster.type : monster.type.type;
			lines.push(`type: ${type}`);
			// Subtype/tags
			if (typeof monster.type === "object" && monster.type.tags && monster.type.tags.length > 0) {
				lines.push(`subtype: ${monster.type.tags.join(", ")}`);
			}
		}

		// Alignment
		if (monster.alignment) {
			const alignments = Array.isArray(monster.alignment) ? monster.alignment : [monster.alignment];
			lines.push(`alignment: ${Parser.alignmentListToFull(alignments).toLowerCase()}`);
		}

		// AC
		if (monster.ac) {
			const acVal = Array.isArray(monster.ac) ?
				(typeof monster.ac[0] === "number" ? monster.ac[0] : monster.ac[0].ac) :
				monster.ac;
			lines.push(`ac: ${acVal}`);
		}

		// HP
		if (monster.hp) {
			const hp = monster.hp.average || monster.hp.special || 0;
			lines.push(`hp: ${hp}`);
			if (monster.hp.formula) {
				lines.push(`hit_dice: ${monster.hp.formula}`);
			}
		}

		// Speed
		if (monster.speed) {
			lines.push(`speed: ${Parser.getSpeedString(monster)}`);
		}

		// Stats array [str, dex, con, int, wis, cha]
		if (monster.str !== undefined) {
			lines.push(`stats: [${monster.str}, ${monster.dex}, ${monster.con}, ${monster.int}, ${monster.wis}, ${monster.cha}]`);
		}

		// Saves
		if (monster.save) {
			lines.push(`saves:`);
			for (const [ability, value] of Object.entries(monster.save)) {
				lines.push(`  - ${ability}: ${value}`);
			}
		}

		// Skills
		if (monster.skill) {
			lines.push(`skillsaves:`);
			for (const [skill, value] of Object.entries(monster.skill)) {
				lines.push(`  - ${skill}: ${value}`);
			}
		}

		// Damage vulnerabilities
		if (monster.vulnerable && monster.vulnerable.length) {
			const vulns = Array.isArray(monster.vulnerable) ? monster.vulnerable.join(", ") : monster.vulnerable;
			lines.push(`damage_vulnerabilities: ${vulns}`);
		}

		// Damage resistances
		if (monster.resist && monster.resist.length) {
			const resists = Array.isArray(monster.resist) ? monster.resist.join(", ") : monster.resist;
			lines.push(`damage_resistances: ${resists}`);
		}

		// Damage immunities
		if (monster.immune && monster.immune.length) {
			const immunes = Array.isArray(monster.immune) ? monster.immune.join(", ") : monster.immune;
			lines.push(`damage_immunities: ${immunes}`);
		}

		// Condition immunities
		if (monster.conditionImmune && monster.conditionImmune.length) {
			const condImmunes = Array.isArray(monster.conditionImmune) ? monster.conditionImmune.join(", ") : monster.conditionImmune;
			lines.push(`condition_immunities: ${condImmunes}`);
		}

		// Senses
		if (monster.senses || monster.passive !== undefined) {
			const senseParts = [];
			if (monster.senses) {
				const senses = Array.isArray(monster.senses) ? monster.senses.join(", ") : monster.senses;
				senseParts.push(senses);
			}
			if (monster.passive !== undefined) {
				senseParts.push(`passive Perception ${monster.passive}`);
			}
			lines.push(`senses: ${senseParts.join(", ")}`);
		}

		// Languages
		if (monster.languages) {
			const langs = Array.isArray(monster.languages) ? monster.languages.join(", ") : monster.languages;
			lines.push(`languages: ${this._escapeYamlString(langs)}`);
		}

		// CR
		if (monster.cr !== undefined) {
			const cr = typeof monster.cr === "object" ? monster.cr.cr : monster.cr;
			lines.push(`cr: ${this._escapeYamlString(String(cr))}`);
		}

		// Traits
		if (monster.trait && monster.trait.length) {
			lines.push(`traits:`);
			for (const trait of monster.trait) {
				const name = trait.name ? this._renderString(trait.name) : "";
				const desc = trait.entries ? this._unescapeWikilinks(this._renderEntries(trait.entries).replace(/\n/g, " ")) : "";
				lines.push(`  - name: ${this._escapeYamlString(name)}`);
				lines.push(`    desc: ${this._escapeYamlString(desc)}`);
			}
		}

		// Spellcasting (as a trait)
		if (monster.spellcasting && monster.spellcasting.length) {
			if (!monster.trait || !monster.trait.length) {
				lines.push(`traits:`);
			}
			for (const sc of monster.spellcasting) {
				const name = sc.name || "Spellcasting";
				let desc = "";
				if (sc.headerEntries) {
					desc += this._renderEntries(sc.headerEntries);
				}
				if (sc.spells) {
					const spellParts = [];
					for (const [level, spellData] of Object.entries(sc.spells)) {
						if (spellData.spells && spellData.spells.length) {
							const levelStr = level === "0" ? "Cantrips" : `${level}${this._getOrdinalSuffix(parseInt(level))} level`;
							const slots = spellData.slots ? ` (${spellData.slots} slots)` : "";
							const spellList = spellData.spells.map(spell => this._renderString(spell)).join(", ");
							spellParts.push(`${levelStr}${slots}: ${spellList}`);
						}
					}
					if (spellParts.length) {
						desc += " " + spellParts.join("; ");
					}
				}
				lines.push(`  - name: ${this._escapeYamlString(name)}`);
				lines.push(`    desc: ${this._escapeYamlString(this._unescapeWikilinks(desc.replace(/\n/g, " ").trim()))}`);
			}
		}

		// Actions
		if (monster.action && monster.action.length) {
			lines.push(`actions:`);
			for (const action of monster.action) {
				const name = action.name ? this._renderString(action.name) : "";
				const desc = action.entries ? this._unescapeWikilinks(this._renderEntries(action.entries).replace(/\n/g, " ")) : "";
				lines.push(`  - name: ${this._escapeYamlString(name)}`);
				lines.push(`    desc: ${this._escapeYamlString(desc)}`);
			}
		}

		// Bonus Actions
		if (monster.bonus && monster.bonus.length) {
			lines.push(`bonus_actions:`);
			for (const bonus of monster.bonus) {
				const name = bonus.name ? this._renderString(bonus.name) : "";
				const desc = bonus.entries ? this._unescapeWikilinks(this._renderEntries(bonus.entries).replace(/\n/g, " ")) : "";
				lines.push(`  - name: ${this._escapeYamlString(name)}`);
				lines.push(`    desc: ${this._escapeYamlString(desc)}`);
			}
		}

		// Reactions
		if (monster.reaction && monster.reaction.length) {
			lines.push(`reactions:`);
			for (const reaction of monster.reaction) {
				const name = reaction.name ? this._renderString(reaction.name) : "";
				const desc = reaction.entries ? this._unescapeWikilinks(this._renderEntries(reaction.entries).replace(/\n/g, " ")) : "";
				lines.push(`  - name: ${this._escapeYamlString(name)}`);
				lines.push(`    desc: ${this._escapeYamlString(desc)}`);
			}
		}

		// Legendary Actions
		if (monster.legendary && monster.legendary.length) {
			lines.push(`legendary_actions:`);
			for (const legendary of monster.legendary) {
				const name = legendary.name ? this._renderString(legendary.name) : "";
				const desc = legendary.entries ? this._unescapeWikilinks(this._renderEntries(legendary.entries).replace(/\n/g, " ")) : "";
				lines.push(`  - name: ${this._escapeYamlString(name)}`);
				lines.push(`    desc: ${this._escapeYamlString(desc)}`);
			}
		}

		// Mythic Actions
		if (monster.mythic && monster.mythic.length) {
			lines.push(`mythic_actions:`);
			for (const mythic of monster.mythic) {
				const name = mythic.name ? this._renderString(mythic.name) : "";
				const desc = mythic.entries ? this._unescapeWikilinks(this._renderEntries(mythic.entries).replace(/\n/g, " ")) : "";
				lines.push(`  - name: ${this._escapeYamlString(name)}`);
				lines.push(`    desc: ${this._escapeYamlString(desc)}`);
			}
		}

		return lines.join("\n");
	}

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

		// Load monster fluff data for images
		this.monsterFluffLookup = new Map();
		try {
			const bestiaryDir = path.join(this.dataDir, "bestiary");
			const fluffFiles = fs.readdirSync(bestiaryDir).filter(f => f.startsWith("fluff-bestiary-"));
			for (const file of fluffFiles) {
				const filePath = path.join(bestiaryDir, file);
				const data = readJson(filePath);
				const fluffEntries = data.monsterFluff || [];
				for (const fluff of fluffEntries) {
					if (!fluff.name || !fluff.source) continue;
					const key = `${fluff.name}|${fluff.source}`.toLowerCase();

					// Skip if already have an image for this monster
					if (this.monsterFluffLookup.has(key)) continue;

					// Check direct images array
					let firstImage = null;
					if (fluff.images && fluff.images.length > 0) {
						firstImage = fluff.images[0];
					}
					// Check _copy._mod.images.items (for entries using inheritance)
					else if (fluff._copy?._mod?.images?.items && fluff._copy._mod.images.items.length > 0) {
						firstImage = fluff._copy._mod.images.items[0];
					}

					if (firstImage?.href?.type === "internal" && firstImage.href?.path) {
						this.monsterFluffLookup.set(key, firstImage.href.path);
					}
				}
			}
			this.log(`Loaded monster fluff data (${this.monsterFluffLookup.size} monsters with images)`);
		} catch (e) {
			console.warn("Failed to load monster fluff, images won't be added:", e.message);
		}

		// Load item data for source lookup (when @item tags don't specify source)
		// Stores {source, type, name} where type indicates where the item file lives
		this.itemLookup = new Map();
		try {
			const itemFiles = ["items.json", "items-base.json"];
			for (const file of itemFiles) {
				const filePath = path.join(this.dataDir, file);
				if (fs.existsSync(filePath)) {
					const data = readJson(filePath);
					const items = data.item || data.baseitem || [];
					for (const item of items) {
						if (item.name && item.source) {
							const key = item.name.toLowerCase();
							// Only set if not already present (first source wins)
							if (!this.itemLookup.has(key)) {
								this.itemLookup.set(key, {source: item.source, type: "item", name: item.name});
							}
						}
					}
				}
			}
			this.log(`Loaded item lookup data (${this.itemLookup.size} items)`);
		} catch (e) {
			console.warn("Failed to load item lookup, item sources may be incorrect:", e.message);
		}

		// Load magic variant data for source lookup
		this.magicVariantLookup = new Map();
		try {
			const magicVariantsPath = path.join(this.dataDir, "magicvariants.json");
			if (fs.existsSync(magicVariantsPath)) {
				const data = readJson(magicVariantsPath);
				const variants = data.magicvariant || [];
				for (const variant of variants) {
					if (variant.name && variant.inherits?.source) {
						const key = variant.name.toLowerCase();
						// Only set if not already present (first source wins)
						if (!this.magicVariantLookup.has(key)) {
							this.magicVariantLookup.set(key, variant.inherits.source);
						}
						// Also add to itemLookup so @item tags can find magic variants
						if (!this.itemLookup.has(key)) {
							this.itemLookup.set(key, {source: variant.inherits.source, type: "magicvariant", name: variant.name});
						}
					}
				}
				this.log(`Loaded magic variant lookup data (${this.magicVariantLookup.size} variants)`);
			}
		} catch (e) {
			console.warn("Failed to load magic variant lookup:", e.message);
		}

		// Load item group data for source lookup (stores {name, source} to preserve proper casing)
		this.itemGroupLookup = new Map();
		try {
			const itemsPath = path.join(this.dataDir, "items.json");
			if (fs.existsSync(itemsPath)) {
				const data = readJson(itemsPath);
				const groups = data.itemGroup || [];
				for (const group of groups) {
					if (group.name && group.source) {
						const key = group.name.toLowerCase();
						// Only set if not already present (first source wins)
						if (!this.itemGroupLookup.has(key)) {
							this.itemGroupLookup.set(key, {name: group.name, source: group.source});
						}
					}
				}
				this.log(`Loaded item group lookup data (${this.itemGroupLookup.size} groups)`);
			}
		} catch (e) {
			console.warn("Failed to load item group lookup:", e.message);
		}

		// Load item type data for concepts (maps "abbr|source" -> {name, source, abbreviation, items[]})
		this.itemTypeLookup = new Map();
		try {
			const itemsBasePath = path.join(this.dataDir, "items-base.json");
			if (fs.existsSync(itemsBasePath)) {
				const data = readJson(itemsBasePath);
				const types = data.itemType || [];
				for (const type of types) {
					if (type.abbreviation && type.source) {
						const key = `${type.abbreviation}|${type.source}`.toLowerCase();
						// Only set if not already present (first wins)
						if (!this.itemTypeLookup.has(key)) {
							this.itemTypeLookup.set(key, {
								name: type.name,
								source: type.source,
								abbreviation: type.abbreviation,
								items: [],
							});
						}
					}
				}
				this.log(`Loaded item type lookup data (${this.itemTypeLookup.size} types)`);

				// Now collect items for each type
				const itemFiles = ["items.json", "items-base.json"];
				for (const file of itemFiles) {
					const filePath = path.join(this.dataDir, file);
					if (fs.existsSync(filePath)) {
						const itemData = readJson(filePath);
						const items = itemData.item || itemData.baseitem || [];
						for (const item of items) {
							if (item.type && item.name && item.source) {
								// type can be "A" or "A|XPHB" format
								const typeKey = item.type.includes("|")
									? item.type.toLowerCase()
									: `${item.type}|${item.source}`.toLowerCase();
								const typeData = this.itemTypeLookup.get(typeKey);
								if (typeData) {
									typeData.items.push({name: item.name, source: item.source});
								}
							}
						}
					}
				}
			}
		} catch (e) {
			console.warn("Failed to load item type lookup:", e.message);
		}

		// Set item lookup on renderer
		this.renderer.setItemLookup(this.itemLookup);

		// Initialize generators with loaded data
		this.frontmatterGenerator = new FrontmatterGenerator(this.spellClassLookup);
		this.formatter = new MarkdownFormatter(this.renderer, this.legendaryGroups, this.magicVariantLookup, this.itemGroupLookup, this.itemTypeLookup, this.monsterFluffLookup);
	}

	/**
	 * Resource type mapping
	 */
	static RESOURCE_TYPE_MAP = {
		spell: {dir: "Spells"},
		monster: {dir: "Bestiary"},
		item: {dir: "Items"},
		baseitem: {dir: "Items"},
		class: {dir: "Classes"},  // Note: actual path determined dynamically for hierarchy
		subclass: {dir: "Classes"},  // Note: actual path determined dynamically for hierarchy
		background: {dir: "Backgrounds"},
		feat: {dir: "Feats"},
		race: {dir: "Races"},
		subrace: {dir: "Races"},
		condition: {dir: "Rules/Conditions"},
		disease: {dir: "Rules/Conditions"},
		deity: {dir: "Deities"},
		action: {dir: "Actions"},
		vehicle: {dir: "Vehicles"},
		vehicleUpgrade: {dir: "Vehicles/Vehicle Upgrades"},
		object: {dir: "Objects"},
		optionalfeature: {dir: "Optional Features"},
		reward: {dir: "Rewards"},
		psionic: {dir: "Psionics"},
		variantrule: {dir: "Rules/Variant Rules"},
		sense: {dir: "Rules/Senses"},
		status: {dir: "Rules/Conditions"},
		itemProperty: {dir: "Rules/Weapon Properties"},
		itemMastery: {dir: "Rules/Weapon Mastery"},
		table: {dir: "Tables"},
		language: {dir: "Languages"},
		trap: {dir: "Traps Hazards"},
		hazard: {dir: "Traps Hazards"},
		cult: {dir: "Cults Boons"},
		boon: {dir: "Cults Boons"},
		facility: {dir: "Facilities"},
		recipe: {dir: "Recipes"},
		charoption: {dir: "Character Options"},
		magicvariant: {dir: "Items/Magic Variants"},
		itemGroup: {dir: "Items/Groups"},
		itemType: {dir: "Rules/Concepts"},
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
			// Some resource types are in files with different names
			const typeToFileMapping = {
				"itemtype": "items-base",
			};
			filesToProcess = files.filter(file => {
				// Check if file contains any of the specified resource types
				// This is a simple heuristic - we'll validate when we read the file
				return resourceTypes.some(type => {
					const mappedFile = typeToFileMapping[type];
					if (mappedFile && file.includes(mappedFile)) return true;
					return file.includes(type);
				});
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
	 * Get folder name for optional feature type
	 * Returns the plural folder name for a given feature type code
	 */
	_getOptionalFeatureFolder(featureTypeCodes) {
		if (!featureTypeCodes || featureTypeCodes.length === 0) {
			return "Other";
		}

		// Use the first feature type to determine folder
		const typeCode = featureTypeCodes[0];
		const parts = typeCode.split(":");

		const folderMap = {
			"AI": "Artificer Infusions",
			"AS": "Arcane Shots",
			"ED": "Elemental Disciplines",
			"EI": "Eldritch Invocations",
			"FS": "Fighting Styles",
			"MM": "Metamagic",
			"MV": "Maneuvers",
			"PB": "Pact Boons",
			"RN": "Runes",
			"RP": "Rune Powers"
		};

		return folderMap[parts[0]] || "Other";
	}

	/**
	 * Process a single data file
	 */
	async processFile(sourceFile, force = false) {
		this.log(`Processing ${sourceFile}...`);

		// Special handling for loot.json and life.json
		const filename = path.basename(sourceFile);
		if (filename === "loot.json") {
			return await this.processLootFile(sourceFile, force);
		}
		if (filename === "life.json") {
			return await this.processLifeFile(sourceFile, force);
		}

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
		// For itemProperty, the name is nested in entries[0].name
		// For magicvariant, source is in inherits.source
		let displayName = entry.name;
		if (entryType === "subrace" && entry.raceName) {
			displayName = `${entry.name} ${entry.raceName}`;
		} else if (entryType === "itemProperty") {
			displayName = entry.entries?.[0]?.name || "Unknown Property";
		}
		let entrySource = entry.source;
		if (entryType === "magicvariant" && entry.inherits?.source) {
			entrySource = entry.inherits.source;
		}
		const filename = this._sanitizeFilename(`${displayName} - ${entrySource || "Unknown"}.md`);

		// Determine output path - special handling for class/subclass hierarchy and optional features
		let outputPath;
		if (entryType === "class") {
			// Classes go in: Classes/{ClassName}/{ClassName} - {Source}.md
			const className = this._sanitizeFilename(entry.name);
			outputPath = path.join(this.outputDir, "Classes", className, filename);
		} else if (entryType === "subclass") {
			// Subclasses go in: Classes/{ClassName}/Subclasses/{SubclassName} - {Source}.md
			const className = this._sanitizeFilename(entry.className);
			outputPath = path.join(this.outputDir, "Classes", className, "Subclasses", filename);
		} else if (entryType === "optionalfeature") {
			// Optional features go in: Optional Features/{FeatureType}/{Name} - {Source}.md
			const featureTypeFolder = this._getOptionalFeatureFolder(entry.featureType);
			outputPath = path.join(this.outputDir, "Optional Features", featureTypeFolder, filename);
		} else {
			// All other types use the standard directory from RESOURCE_TYPE_MAP
			outputPath = path.join(this.outputDir, resourceInfo.dir, filename);
		}

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

	// ===== LOOT AND LIFE TABLE PROCESSING =====

	/**
	 * Process loot.json file
	 */
	async processLootFile(sourceFile, force = false) {
		this.log(`Processing loot tables from ${sourceFile}...`);
		const data = readJson(sourceFile);

		const lootCategories = [
			{key: 'gems', folder: 'Gems', rollerName: 'Gems Roller', formatter: (t) => this._formatGemsTable(t)},
			{key: 'individual', folder: 'Individual', rollerName: 'Individual Treasure Roller', formatter: (t) => this._formatIndividualTreasureTable(t)},
			{key: 'hoard', folder: 'Hoard', rollerName: 'Hoard Roller', formatter: (t) => this._formatHoardTable(t)},
			{key: 'magicItems', folder: 'Magic Items', rollerName: 'Magic Items Roller', formatter: (t) => this._formatMagicItemsTable(t)},
			{key: 'dragon', folder: 'Dragon', rollerName: 'Dragon Hoard Roller', formatter: (t) => this._formatDragonTable(t)}
		];

		for (const category of lootCategories) {
			if (!data[category.key]) continue;

			const outputDir = path.join(this.outputDir, "Tables", "Loot", category.folder);
			if (!fs.existsSync(outputDir)) {
				fs.mkdirSync(outputDir, {recursive: true});
			}

			// Export individual tables
			for (const table of data[category.key]) {
				const filename = this._sanitizeFilename(`${table.name} - ${table.source}.md`);
				const outputPath = path.join(outputDir, filename);
				const markdown = category.formatter(table);
				fs.writeFileSync(outputPath, markdown, "utf8");
				this.stats.updated++;
				this.log(`  ✓ Exported ${filename}`);
			}

			// Create master roll file
			await this._createLootMasterRollFile(data[category.key], category.key, category.rollerName, outputDir);
		}
	}

	/**
	 * Process life.json file
	 */
	async processLifeFile(sourceFile, force = false) {
		this.log(`Processing life tables from ${sourceFile}...`);
		const data = readJson(sourceFile);

		const baseDir = path.join(this.outputDir, "Tables", "Life Random Generators");

		// Process lifeTrinket - just an array of strings
		if (data.lifeTrinket) {
			const trinketDir = path.join(baseDir, "Trinkets");
			if (!fs.existsSync(trinketDir)) {
				fs.mkdirSync(trinketDir, {recursive: true});
			}

			const markdown = this._formatLifeTrinketTable(data.lifeTrinket);
			const outputPath = path.join(trinketDir, "Trinkets.md");
			fs.writeFileSync(outputPath, markdown, "utf8");
			this.stats.updated++;
			this.log(`  ✓ Exported Trinkets.md`);
		}

		// Process lifeBackground
		if (data.lifeBackground) {
			const bgDir = path.join(baseDir, "Backgrounds");
			if (!fs.existsSync(bgDir)) {
				fs.mkdirSync(bgDir, {recursive: true});
			}

			for (const entry of data.lifeBackground) {
				const filename = this._sanitizeFilename(`${entry.name}.md`);
				const outputPath = path.join(bgDir, filename);
				const markdown = this._formatLifeEntry(entry, 'background');
				fs.writeFileSync(outputPath, markdown, "utf8");
				this.stats.updated++;
				this.log(`  ✓ Exported ${filename}`);
			}

			// Create roller file
			await this._createLifeRollerFile(data.lifeBackground, 'Backgrounds', bgDir);
		}

		// Process lifeClass
		if (data.lifeClass) {
			const classDir = path.join(baseDir, "Classes");
			if (!fs.existsSync(classDir)) {
				fs.mkdirSync(classDir, {recursive: true});
			}

			for (const entry of data.lifeClass) {
				const filename = this._sanitizeFilename(`${entry.name}.md`);
				const outputPath = path.join(classDir, filename);
				const markdown = this._formatLifeEntry(entry, 'class');
				fs.writeFileSync(outputPath, markdown, "utf8");
				this.stats.updated++;
				this.log(`  ✓ Exported ${filename}`);
			}

			// Create roller file
			await this._createLifeRollerFile(data.lifeClass, 'Classes', classDir);
		}
	}

	/**
	 * Format gems table
	 */
	_formatGemsTable(table) {
		const parts = [];

		// Frontmatter
		parts.push(`---`);
		parts.push(`name: "${table.name}"`);
		parts.push(`source: ${table.source}`);
		if (table.page) parts.push(`page: ${table.page}`);
		parts.push(`type: loot-gems`);
		parts.push(`tags:`);
		parts.push(`  - "dnd5e/loot"`);
		parts.push(`  - "dnd5e/loot/gems"`);
		parts.push(`---`);
		parts.push(`# ${table.name}\n`);

		// Table
		parts.push(`| dice: 1d${table.table.length} | Gemstone |`);
		parts.push(`| --- | --- |`);

		for (let i = 0; i < table.table.length; i++) {
			const gem = table.table[i];
			const gemText = this.formatter._renderString(gem);
			parts.push(`| ${i + 1} | ${gemText} |`);
		}

		const blockId = this.formatter._generateTableBlockId(table.name);
		parts.push(`^${blockId}\n`);

		// Source
		if (table.source) {
			const sourceFull = Parser.sourceJsonToFull(table.source);
			const pageStr = table.page ? `, page ${table.page}` : "";
			parts.push(`\n---\n**Source:** *${sourceFull}*${pageStr}`);
		}

		return parts.join("\n");
	}

	/**
	 * Format individual treasure table
	 */
	_formatIndividualTreasureTable(table) {
		const parts = [];

		// Frontmatter
		parts.push(`---`);
		parts.push(`name: "${table.name}"`);
		parts.push(`source: ${table.source}`);
		if (table.page) parts.push(`page: ${table.page}`);
		parts.push(`type: loot-individual`);
		parts.push(`tags:`);
		parts.push(`  - "dnd5e/loot"`);
		parts.push(`  - "dnd5e/loot/individual"`);
		parts.push(`---`);
		parts.push(`# ${table.name}\n`);

		// Table
		parts.push(`| dice: 1d100 | Treasure |`);
		parts.push(`| --- | --- |`);

		for (const row of table.table) {
			const range = row.min === row.max ? `${row.min}` : `${row.min}-${row.max}`;
			const coins = this._formatCoins(row.coins);
			parts.push(`| ${range} | ${coins} |`);
		}

		const blockId = this.formatter._generateTableBlockId(table.name);
		parts.push(`^${blockId}\n`);

		// Source
		if (table.source) {
			const sourceFull = Parser.sourceJsonToFull(table.source);
			const pageStr = table.page ? `, page ${table.page}` : "";
			parts.push(`\n---\n**Source:** *${sourceFull}*${pageStr}`);
		}

		return parts.join("\n");
	}

	/**
	 * Format hoard table
	 */
	_formatHoardTable(table) {
		const parts = [];

		// Frontmatter
		parts.push(`---`);
		parts.push(`name: "${table.name}"`);
		parts.push(`source: ${table.source}`);
		if (table.page) parts.push(`page: ${table.page}`);
		parts.push(`type: loot-hoard`);
		parts.push(`tags:`);
		parts.push(`  - "dnd5e/loot"`);
		parts.push(`  - "dnd5e/loot/hoard"`);
		parts.push(`---`);
		parts.push(`# ${table.name}\n`);

		// Show coins if present
		if (table.coins) {
			parts.push(`**Coins:** ${this._formatCoins(table.coins)}\n`);
		}

		// Table
		parts.push(`| dice: 1d100 | Additional Treasure |`);
		parts.push(`| --- | --- |`);

		for (const row of table.table) {
			const range = row.min === row.max ? `${row.min}` : `${row.min}-${row.max}`;
			let treasure = this._formatHoardRow(row);
			parts.push(`| ${range} | ${treasure} |`);
		}

		const blockId = this.formatter._generateTableBlockId(table.name);
		parts.push(`^${blockId}\n`);

		// Source
		if (table.source) {
			const sourceFull = Parser.sourceJsonToFull(table.source);
			const pageStr = table.page ? `, page ${table.page}` : "";
			parts.push(`\n---\n**Source:** *${sourceFull}*${pageStr}`);
		}

		return parts.join("\n");
	}

	/**
	 * Format magic items table
	 */
	_formatMagicItemsTable(table) {
		const parts = [];

		// Frontmatter
		parts.push(`---`);
		parts.push(`name: "${table.name}"`);
		parts.push(`source: ${table.source}`);
		if (table.page) parts.push(`page: ${table.page}`);
		parts.push(`type: loot-magicItems`);
		parts.push(`tags:`);
		parts.push(`  - "dnd5e/loot"`);
		parts.push(`  - "dnd5e/loot/magicItems"`);
		parts.push(`---`);
		parts.push(`# ${table.name}\n`);

		// Table
		parts.push(`| dice: 1d100 | Magic Item |`);
		parts.push(`| --- | --- |`);

		for (const row of table.table) {
			const range = row.min === row.max ? `${row.min}` : `${row.min}-${row.max}`;
			let item = this._formatMagicItemRow(row);
			parts.push(`| ${range} | ${item} |`);
		}

		const blockId = this.formatter._generateTableBlockId(table.name);
		parts.push(`^${blockId}\n`);

		// Source
		if (table.source) {
			const sourceFull = Parser.sourceJsonToFull(table.source);
			const pageStr = table.page ? `, page ${table.page}` : "";
			parts.push(`\n---\n**Source:** *${sourceFull}*${pageStr}`);
		}

		return parts.join("\n");
	}

	/**
	 * Format dragon loot table
	 */
	_formatDragonTable(table) {
		const parts = [];

		// Frontmatter
		parts.push(`---`);
		parts.push(`name: "${table.name}"`);
		parts.push(`source: ${table.source}`);
		if (table.page) parts.push(`page: ${table.page}`);
		parts.push(`type: loot-dragon`);
		parts.push(`tags:`);
		parts.push(`  - "dnd5e/loot"`);
		parts.push(`  - "dnd5e/loot/dragon"`);
		parts.push(`---`);
		parts.push(`# ${table.name}\n`);

		// Show coins if present
		if (table.coins) {
			parts.push(`**Coins:** ${this._formatCoins(table.coins)}\n`);
		}

		// Additional info
		if (table.dragonMundaneItems) {
			parts.push(`**Mundane Items:** ${table.dragonMundaneItems.amount}\n`);
		}

		if (table.gems) {
			parts.push(`**Gems:** ${table.gems.amount}\n`);
		}

		if (table.artObjects) {
			parts.push(`**Art Objects:** ${table.artObjects.amount}\n`);
		}

		// Source
		if (table.source) {
			const sourceFull = Parser.sourceJsonToFull(table.source);
			const pageStr = table.page ? `, page ${table.page}` : "";
			parts.push(`\n---\n**Source:** *${sourceFull}*${pageStr}`);
		}

		return parts.join("\n");
	}

	/**
	 * Format dragon mundane items table
	 */
	_formatDragonMundaneItemsTable(table) {
		const parts = [];

		// Frontmatter
		parts.push(`---`);
		parts.push(`name: "${table.name}"`);
		parts.push(`source: ${table.source}`);
		if (table.page) parts.push(`page: ${table.page}`);
		parts.push(`type: loot-dragonMundaneItems`);
		parts.push(`tags:`);
		parts.push(`  - "dnd5e/loot"`);
		parts.push(`  - "dnd5e/loot/dragonMundaneItems"`);
		parts.push(`---`);
		parts.push(`# ${table.name}\n`);

		// Table
		parts.push(`| dice: 1d${table.table.length} | Item |`);
		parts.push(`| --- | --- |`);

		for (let i = 0; i < table.table.length; i++) {
			const item = table.table[i];
			const itemText = this.formatter._renderString(item);
			parts.push(`| ${i + 1} | ${itemText} |`);
		}

		const blockId = this.formatter._generateTableBlockId(table.name);
		parts.push(`^${blockId}\n`);

		// Source
		if (table.source) {
			const sourceFull = Parser.sourceJsonToFull(table.source);
			const pageStr = table.page ? `, page ${table.page}` : "";
			parts.push(`\n---\n**Source:** *${sourceFull}*${pageStr}`);
		}

		return parts.join("\n");
	}

	/**
	 * Helper: Format coins object to string
	 * Escapes * characters to prevent markdown bold interpretation
	 */
	_formatCoins(coins) {
		if (!coins) return "—";
		const parts = [];
		// Escape * to \* to prevent markdown interpretation
		const escape = (val) => String(val).replace(/\*/g, "\\*");
		if (coins.cp) parts.push(`${escape(coins.cp)} cp`);
		if (coins.sp) parts.push(`${escape(coins.sp)} sp`);
		if (coins.ep) parts.push(`${escape(coins.ep)} ep`);
		if (coins.gp) parts.push(`${escape(coins.gp)} gp`);
		if (coins.pp) parts.push(`${escape(coins.pp)} pp`);
		return parts.join(", ") || "—";
	}

	/**
	 * Helper: Format hoard table row
	 */
	_formatHoardRow(row) {
		const parts = [];
		if (row.gems) {
			parts.push(`${row.gems.amount} × ${row.gems.type} gp gems`);
		}
		if (row.artObjects) {
			parts.push(`${row.artObjects.amount} × ${row.artObjects.type} gp art objects`);
		}
		if (row.magicItems) {
			for (const mi of row.magicItems) {
				parts.push(`${mi.amount} from Magic Item Table ${mi.type}`);
			}
		}
		return parts.join(" + ") || "—";
	}

	/**
	 * Helper: Format magic item row with nested rolls
	 */
	_formatMagicItemRow(row) {
		if (row.item) {
			// Check if this is a plain text reference (no {@item} tag)
			// If it matches an item group, create a link with proper casing
			if (!row.item.includes("{@") && this.itemGroupLookup) {
				const lookupKey = row.item.toLowerCase();
				if (this.itemGroupLookup.has(lookupKey)) {
					const {name, source} = this.itemGroupLookup.get(lookupKey);
					const tableNote = row.table ? ` (roll \`dice: 1d${row.table.length}\` for specific type)` : "";
					return `[[Items/Groups/${name} - ${source}\\|${name} - ${source}]]${tableNote}`;
				}
			}
			// Check if this has a nested table
			if (row.table) {
				// Create nested dice roll inline
				const itemText = this.formatter._renderString(row.item);
				// For nested tables, we'll create a sub-table and reference it
				return `${itemText} (roll \`dice: 1d${row.table.length}\` for specific type)`;
			} else {
				return this.formatter._renderString(row.item);
			}
		}
		if (row.choose) {
			if (row.choose.fromGeneric) {
				const name = row.choose.fromGeneric[0];
				// Look up source from magic variant data
				const source = this.magicVariantLookup?.get(name.toLowerCase()) || "DMG";
				return `[[Items/Magic Variants/${name} - ${source}\\|${name} - ${source}]]`;
			}
			if (row.choose.fromGroup) {
				const rawName = row.choose.fromGroup[0];
				// Look up proper name and source from item group data
				const lookupResult = this.itemGroupLookup?.get(rawName.toLowerCase());
				const name = lookupResult?.name || rawName;
				const source = lookupResult?.source || "DMG";
				return `[[Items/Groups/${name} - ${source}\\|${name} - ${source}]]`;
			}
		}
		return "Special";
	}

	/**
	 * Create master roll file for loot tables
	 */
	async _createLootMasterRollFile(tables, category, rollerName, outputDir) {
		const parts = [];

		parts.push(`---`);
		parts.push(`name: "${rollerName}"`);
		parts.push(`type: loot-master`);
		parts.push(`---`);
		parts.push(`# ${rollerName}\n`);
		parts.push(`Click any roll button to generate a random result from that table:\n`);

		for (const table of tables) {
			const filename = this._sanitizeFilename(`${table.name} - ${table.source}.md`);
			const blockId = this.formatter._generateTableBlockId(table.name);
			parts.push(`- **${table.name}**: \`dice: [[${filename.replace('.md', '')}^${blockId}]]\``);
		}

		const masterFilename = `${rollerName}.md`;
		const masterPath = path.join(outputDir, masterFilename);
		fs.writeFileSync(masterPath, parts.join("\n"), "utf8");
		this.stats.updated++;
		this.log(`  ✓ Created ${rollerName}`);
	}

	// ===== LIFE TABLE FORMATTERS =====

	/**
	 * Format life trinket table
	 */
	_formatLifeTrinketTable(trinkets) {
		const parts = [];

		parts.push(`---`);
		parts.push(`name: "Trinkets"`);
		parts.push(`type: life-trinket`);
		parts.push(`tags:`);
		parts.push(`  - "dnd5e/life"`);
		parts.push(`  - "dnd5e/life/trinket"`);
		parts.push(`---`);
		parts.push(`# Trinkets\n`);

		parts.push(`| dice: 1d${trinkets.length} | Trinket |`);
		parts.push(`| --- | --- |`);

		for (let i = 0; i < trinkets.length; i++) {
			parts.push(`| ${i + 1} | ${trinkets[i]} |`);
		}

		parts.push(`^trinkets\n`);

		return parts.join("\n");
	}

	/**
	 * Format life entry (background or class)
	 */
	_formatLifeEntry(entry, type) {
		const parts = [];

		parts.push(`---`);
		parts.push(`name: "${entry.name}"`);
		parts.push(`source: ${entry.source}`);
		parts.push(`type: life-${type}`);
		parts.push(`tags:`);
		parts.push(`  - "dnd5e/life"`);
		parts.push(`  - "dnd5e/life/${type}"`);
		parts.push(`---`);
		parts.push(`# ${entry.name}\n`);

		// Reasons table
		if (entry.reasons && entry.reasons.length > 0) {
			parts.push(`## Why ${entry.name}?\n`);
			parts.push(`| dice: 1d${entry.reasons.length} | Reason |`);
			parts.push(`| --- | --- |`);
			for (let i = 0; i < entry.reasons.length; i++) {
				parts.push(`| ${i + 1} | ${entry.reasons[i]} |`);
			}
			const blockId = this.formatter._generateTableBlockId(`${entry.name}-reasons`);
			parts.push(`^${blockId}\n`);
		}

		// Other tables
		if (entry.other) {
			for (const [tableName, tableData] of Object.entries(entry.other)) {
				parts.push(`## ${tableName}\n`);
				parts.push(`| dice: 1d${tableData.length} | ${tableName} |`);
				parts.push(`| --- | --- |`);
				for (let i = 0; i < tableData.length; i++) {
					parts.push(`| ${i + 1} | ${tableData[i]} |`);
				}
				const blockId = this.formatter._generateTableBlockId(`${entry.name}-${tableName}`);
				parts.push(`^${blockId}\n`);
			}
		}

		return parts.join("\n");
	}

	/**
	 * Create roller file for life tables
	 */
	async _createLifeRollerFile(entries, categoryName, outputDir) {
		const parts = [];

		parts.push(`---`);
		parts.push(`name: "${categoryName} Roller"`);
		parts.push(`type: life-master`);
		parts.push(`---`);
		parts.push(`# ${categoryName} Roller\n`);
		parts.push(`Click any roll button to generate a random result:\n`);

		for (const entry of entries) {
			const filename = this._sanitizeFilename(`${entry.name}.md`);
			parts.push(`\n## ${entry.name}\n`);

			// Reasons
			if (entry.reasons) {
				const blockId = this.formatter._generateTableBlockId(`${entry.name}-reasons`);
				parts.push(`- **Why ${entry.name}?**: \`dice: [[${filename.replace('.md', '')}^${blockId}]]\``);
			}

			// Other tables
			if (entry.other) {
				for (const tableName of Object.keys(entry.other)) {
					const blockId = this.formatter._generateTableBlockId(`${entry.name}-${tableName}`);
					parts.push(`- **${tableName}**: \`dice: [[${filename.replace('.md', '')}^${blockId}]]\``);
				}
			}
		}

		const masterFilename = `${categoryName} Roller.md`;
		const masterPath = path.join(outputDir, masterFilename);
		fs.writeFileSync(masterPath, parts.join("\n"), "utf8");
		this.stats.updated++;
		this.log(`  ✓ Created ${categoryName} Roller`);
	}
}

export {
	ObsidianMarkdownRenderer,
	ExportStateTracker,
	FrontmatterGenerator,
	MarkdownFormatter,
	MarkdownExportEngine,
};
