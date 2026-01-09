# "Weird" Resource Types - Detailed Analysis

This document provides in-depth analysis of the resource types you specifically asked about. These are categorized by their actual purpose and exportability.

---

## 1. TOOL/METADATA - DO NOT EXPORT ❌

These are technical data used by the 5etools website, card generator, homebrew tools, etc. They're not game content.

### itemProperty (27 entries)
**File:** `data/items-base.json`

**What it is:** Definitions of weapon and armor properties (Ammunition, Finesse, Heavy, Light, Loading, Range, Reach, Thrown, Two-Handed, Versatile)

**Structure:**
```json
{
  "abbreviation": "2H",
  "source": "PHB",
  "page": 147,
  "template": "{{prop_name_lower}}",
  "entries": [
    {
      "type": "entries",
      "name": "Two-Handed",
      "entries": ["This weapon requires two hands to use..."]
    }
  ]
}
```

**Purpose:** Defines how weapon properties are displayed on the website and in the renderer. Not standalone content.

**Why not export:** These properties are already exported as part of weapons. For example, a longsword already shows "Properties: Versatile" in its export. These are just the definition templates.

**Verdict:** ❌ Metadata only

---

### itemType (63 entries)
**File:** `data/items-base.json`

**What it is:** Definitions of item categories (Treasure, Art Object, Weapon, Armor, Scroll, Potion, Ring, Rod, Staff, Wand, Wondrous Item, etc.)

**Structure:**
```json
{
  "name": "Treasure",
  "abbreviation": "$",
  "source": "DMG",
  "page": 133
}
```

**Purpose:** Category definitions for filtering and organizing items on the website.

**Why not export:** These are category labels, not content. Items already include their type in frontmatter.

**Verdict:** ❌ Metadata only

---

### reducedItemProperty (12 entries)
**File:** `data/makecards.json`

**What it is:** Simplified/abbreviated versions of weapon properties for fitting on physical cards

**Structure:**
```json
{
  "abbreviation": "A",
  "source": "PHB",
  "entries": [
    {
      "type": "entries",
      "name": "Ammunition",
      "entries": [
        "Requires ammo, drawn as part of attack. After combat, spend 1 minute to recover half expended.",
        "Treat as improvised weapon for melee (slings must be loaded)."
      ]
    }
  ]
}
```

**Purpose:** Used by the card generator tool to create printable reference cards with shortened text.

**Why not export:** These are simplified duplicates of `itemProperty` for a specific tool use case.

**Verdict:** ❌ Tool data only

---

### reducedItemType (6 entries)
**File:** `data/makecards.json`

**What it is:** Simplified item type definitions for card generation

**Purpose:** Same as `reducedItemProperty` - for the card-making tool

**Verdict:** ❌ Tool data only

---

### languageScript (6 entries)
**File:** `data/languages.json`

**What it is:** Font file paths for writing systems (Draconic, Dwarvish, Elvish, etc.)

**Structure:**
```json
{
  "name": "Draconic",
  "source": "PHB",
  "fonts": [
    "fonts/languages/PHB/Draconic/Iokharic.otf",
    "fonts/languages/PHB/Draconic/Iokharic Bold.otf"
  ]
}
```

**Purpose:** Website asset references for displaying fancy script fonts when showing language examples.

**Why not export:** These are file paths to font assets, not game content.

**Verdict:** ❌ Asset metadata only

---

### raceFeature (86 entries)
**File:** `data/foundry-races.json`

**What it is:** Foundry VTT-specific data for race features

**Structure:**
```json
{
  "name": "Adrenaline Rush",
  "source": "XPHB",
  "raceName": "Orc",
  "system": {
    "uses.max": "@prof",
    "uses.recovery": [{"period": "sr", "type": "recoverAll"}]
  },
  "activities": [...],
  "migrationVersion": 3
}
```

**Purpose:** Foundry VTT module data. Contains Foundry-specific fields like `system`, `activities`, `migrationVersion`.

**Why not export:**
1. This is VTT module data, not source content
2. Race features are already incorporated into race exports
3. Contains Foundry-specific technical fields

**Verdict:** ❌ Skip (same as other foundry-*.json files)

---

### converterSample (17 entries)
**File:** `data/converter.json`

**What it is:** Example raw text for the homebrew converter tool

**Structure:**
```json
{
  "converterId": "background",
  "format": "txt",
  "edition": "classic",
  "text": "Giant Foundling\nSkill Proficiencies: Intimidation, Survival\n..."
}
```

**Purpose:** Shows users what format to paste into the homebrew converter tool to convert their text to JSON.

**Why not export:** These are tool examples/documentation, not game content. They're teaching materials for using the converter.

**Verdict:** ❌ Tool documentation only

---

## 2. GAME MECHANICS - POTENTIALLY EXPORTABLE ⚠️

These contain actual game rules/mechanics but are used as building blocks or templates rather than standalone entries.

### monsterTemplate (63 entries)
**File:** `data/bestiary/template.json`

**What it is:** Templates that modify monsters (e.g., "make this monster into an Aarakocra version")

**Structure:**
```json
{
  "name": "Aarakocra",
  "source": "DMG",
  "page": 282,
  "ref": "{@race Aarakocra|DMG}",
  "apply": {
    "_root": {
      "size": ["M"],
      "type": {"type": "humanoid", "tags": ["aarakocra"]},
      "speed": {"walk": 30, "fly": 50}
    }
  }
}
```

**Examples:**
- Half-Dragon Template (adds breath weapon, damage resistance)
- Skeleton Template (removes certain abilities, adds undead traits)
- Vampire Spawn Template (adds vampire abilities)
- Shadow Template (changes to shadow form)
- Ghost Template (adds incorporeal traits)

**Purpose:** DMs can apply these to any monster to create variants. "Take an Orc, apply Half-Dragon template, get a Half-Dragon Orc."

**Why it might be exportable:** These are actual game mechanics that DMs reference and use.

**Why it might not be:** They're incomplete without a base monster to apply to. They're transformation rules, not complete stat blocks.

**Recommendation:** ⚠️ **MAYBE** - Could export as variant-rules or special monster-modifications category. Would be useful DM reference.

**Priority:** LOW (only 63 entries, niche use case)

---

### magicvariant (234 entries)
**File:** `data/magicvariants.json`

**What it is:** Generic magic item templates that apply to categories of base items

**Structure:**
```json
{
  "name": "+1 Ammunition",
  "type": "GV|DMG",
  "requires": [{"type": "A"}],
  "ammo": true,
  "inherits": {
    "namePrefix": "+1 ",
    "bonusWeapon": "+1",
    "entries": ["You have a {=bonusWeapon} bonus to attack and damage rolls..."]
  }
}
```

**Examples:**
- "+1 Armor" (applies to any armor)
- "+1 Weapon" (applies to any weapon)
- "+1 Ammunition" (applies to any ammo)
- "Adamantine Armor" (applies to any medium/heavy armor)
- "Mithral Armor" (applies to any medium/heavy armor)
- "Silvered Weapon" (applies to any weapon)

**Purpose:** Instead of having 100 separate entries for "+1 Longsword", "+1 Shortsword", "+1 Greatsword", etc., there's one "+1 Weapon" template that generates all of them.

**Why it might be exportable:** DMs need to reference these rules ("What does Adamantine Armor do?")

**Why it might not be:** They generate hundreds of specific items (e.g., +1 Longsword) which ARE already exported as individual items.

**Recommendation:** ⚠️ **MAYBE** - Could export as reference documents explaining the template. Useful for DMs who want to know "what does +1 weapon mean" without looking up a specific weapon.

**Priority:** MEDIUM (234 entries, commonly referenced)

---

### status (5 entries)
**File:** `data/conditionsdiseases.json`

**What it is:** Game state conditions that aren't traditional negative conditions

**Entries:**
1. **Bloodied** - At half HP or less (XPHB 2024 rule)
2. **Concentration** - Maintaining a spell
3. **Surprised** - Caught unawares in combat

**Why they're separate from conditions:** These aren't debuffs like Poisoned or Charmed. They're general game states.

**Recommendation:** ⚠️ **YES** - Export these! They're actual rules that players/DMs reference.

**How to export:** Either:
- Add to existing conditions export (same folder)
- Or create a new "game-states" folder

**Priority:** HIGH (only 5 entries, but commonly referenced)

**Note:** The analysis document said these are "duplicates" but they're actually distinct from traditional conditions. They should be exported.

---

## 3. TREASURE TABLES - POTENTIALLY EXPORTABLE AS TABLES 💰

These are random generation tables for treasure. Could be exported as markdown tables for DM reference.

### individual (8 entries)
**File:** `data/loot.json`

**What it is:** Individual treasure tables by CR range (DMG p.136)

**Structure:**
```json
{
  "name": "Challenge 0-4",
  "source": "DMG",
  "crMin": 0,
  "crMax": 4,
  "table": [
    {"min": 1, "max": 30, "coins": {"cp": "5d6"}},
    {"min": 31, "max": 60, "coins": {"sp": "4d6"}},
    {"min": 61, "max": 70, "coins": {"ep": "3d6"}},
    {"min": 71, "max": 95, "coins": {"gp": "3d6"}},
    {"min": 96, "max": 100, "coins": {"pp": "1d6"}}
  ]
}
```

**Purpose:** DMs roll d100 to determine what coins a defeated monster drops.

**Recommendation:** ⚠️ **MAYBE** - Could export as markdown tables in a "treasure-tables" folder. Useful DM reference.

**Priority:** LOW (DMs can use online generators, but having in Obsidian would be convenient)

---

### hoard (8 entries)
**File:** `data/loot.json`

**What it is:** Treasure hoard tables by CR range (DMG p.133)

**Similar to individual treasure but for large hoards** (dragon lairs, treasure rooms, etc.)

**Recommendation:** ⚠️ **MAYBE** - Same as individual tables

**Priority:** LOW

---

### gems (12 entries)
**File:** `data/loot.json`

**What it is:** Random gemstone tables by value tier (10 gp, 50 gp, 100 gp, 500 gp, 1,000 gp, 5,000 gp)

**Structure:**
```json
{
  "name": "10 gp Gemstones",
  "value": 10,
  "table": [
    {"min": 1, "max": 10, "item": "Azurite (opaque mottled deep blue)"},
    {"min": 11, "max": 20, "item": "Banded agate (translucent striped brown/blue/white/red)"},
    ...
  ]
}
```

**Purpose:** When treasure says "roll on 100 gp gemstone table," this tells you what gem you get.

**Recommendation:** ⚠️ **MAYBE** - Nice reference for DMs. Could export as tables.

**Priority:** LOW-MEDIUM (flavor reference, commonly used)

---

### dragon (4 entries)
**File:** `data/loot.json`

**What it is:** Dragon hoard treasure tables by age category from Fizban's Treasury of Dragons

**Structure:** Similar to hoard tables but specifically for dragons (Wyrmling, Young, Adult, Ancient)

**Special:** Includes references to `dragonMundaneItems` table

**Recommendation:** ⚠️ **MAYBE** - Useful for DMs running dragon encounters

**Priority:** MEDIUM (dragon encounters are common and iconic)

---

### dragonMundaneItems (25 entries)
**File:** `data/loot.json`

**What it is:** Random table of mundane (non-magical) items found in dragon hoards

**Structure:**
```json
{
  "min": 1,
  "max": 4,
  "item": "A painting by an artist long forgotten by everyone except the dragon"
},
{
  "min": 5,
  "max": 8,
  "item": "A hogshead (large cask) containing 65 gallons of clean drinking water"
},
{
  "min": 9,
  "max": 12,
  "item": "Several embroidered throw pillows depicting wyrmling dragons"
}
```

**Purpose:** Adds flavor to dragon hoards with interesting mundane items (art, furniture, random objects dragons collect)

**Recommendation:** ⚠️ **MAYBE** - Fun flavor table, pairs with dragon hoard tables

**Priority:** LOW (flavor only, not mechanically necessary)

---

### magicItems (33 entries)
**File:** `data/loot.json`

**What it is:** Random magic item tables by CR/tier (Magic Item Table A, B, C, D, E, F, G, H, I from DMG)

**Purpose:** When treasure says "roll on Magic Item Table F," this is that table.

**Recommendation:** ⚠️ **MAYBE** - Standard DM reference tables

**Priority:** MEDIUM (commonly used by DMs)

---

## 4. LIFE MODULE SYSTEM - EXPORTABLE AS TABLES 🎲

From Xanathar's Guide to Everything - character backstory generation tables.

### lifeTrinket (100 entries)
**File:** `data/life.json`

**What it is:** Random trinkets from life events (d100 table)

**Examples:**
- "A small wooden statuette of a smug halfling"
- "A bag of 47 humanoid teeth, one of which is rotten"
- "A half-empty bottle of invisible ink"

**Purpose:** Character creation flavor - roll to get a personal trinket with meaning to your backstory.

**Recommendation:** ⚠️ **YES** - Fun character creation tool

**Priority:** MEDIUM (character creation content)

---

### lifeBackground (13 entries)
**File:** `data/life.json`

**What it is:** Background-specific life event tables

**Structure:** For each background (Acolyte, Criminal, Folk Hero, etc.), contains random life events that shaped that character

**Purpose:** Adds depth to character backstories

**Recommendation:** ⚠️ **YES** - Character creation content

**Priority:** MEDIUM

---

### lifeClass (12 entries)
**File:** `data/life.json`

**What it is:** Class-specific life event tables

**Structure:** For each class (Barbarian, Bard, Cleric, etc.), contains random events explaining how they became that class

**Purpose:** "Why did you become a Wizard?" - roll on this table

**Recommendation:** ⚠️ **YES** - Character creation content

**Priority:** MEDIUM

---

## SUMMARY TABLE

| Resource Type | Count | Category | Export? | Priority |
|---------------|-------|----------|---------|----------|
| **itemProperty** | 27 | Metadata | ❌ No | N/A |
| **itemType** | 63 | Metadata | ❌ No | N/A |
| **reducedItemProperty** | 12 | Tool Data | ❌ No | N/A |
| **reducedItemType** | 6 | Tool Data | ❌ No | N/A |
| **languageScript** | 6 | Asset Metadata | ❌ No | N/A |
| **raceFeature** | 86 | Foundry VTT | ❌ No | N/A |
| **converterSample** | 17 | Tool Docs | ❌ No | N/A |
| **monsterTemplate** | 63 | Templates | ⚠️ Maybe | LOW |
| **magicvariant** | 234 | Templates | ⚠️ Maybe | MEDIUM |
| **status** | 5 | Game Rules | ✅ Yes | **HIGH** |
| **individual** | 8 | Treasure Tables | ⚠️ Maybe | LOW |
| **hoard** | 8 | Treasure Tables | ⚠️ Maybe | LOW |
| **gems** | 12 | Treasure Tables | ⚠️ Maybe | LOW-MEDIUM |
| **dragon** | 4 | Treasure Tables | ⚠️ Maybe | MEDIUM |
| **dragonMundaneItems** | 25 | Treasure Tables | ⚠️ Maybe | LOW |
| **magicItems** | 33 | Treasure Tables | ⚠️ Maybe | MEDIUM |
| **lifeTrinket** | 100 | Character Creation | ⚠️ Yes | MEDIUM |
| **lifeBackground** | 13 | Character Creation | ⚠️ Yes | MEDIUM |
| **lifeClass** | 12 | Character Creation | ⚠️ Yes | MEDIUM |

---

## RECOMMENDATIONS

### DO NOT EXPORT (467 entries) ❌
- itemProperty, itemType (metadata definitions)
- reducedItemProperty, reducedItemType (card generator data)
- languageScript (font file paths)
- raceFeature (Foundry VTT data - already skipping foundry files)
- converterSample (tool documentation)

**Total to skip:** 217 entries

---

### DEFINITELY EXPORT (130 entries) ✅

1. **status** (5 entries) - HIGH PRIORITY
   - Export as conditions or game-states
   - These are actual game rules players reference

2. **Life Module System** (125 entries) - MEDIUM PRIORITY
   - lifeTrinket (100)
   - lifeBackground (13)
   - lifeClass (12)
   - Export as tables in character-creation folder
   - Useful for players building backstories

**Total to add:** 130 entries

---

### CONSIDER FOR FUTURE (314 entries) ⚠️

1. **Templates** (297 entries)
   - monsterTemplate (63) - DM reference for monster variants
   - magicvariant (234) - Generic magic item rules

2. **Treasure Tables** (90 entries)
   - individual (8)
   - hoard (8)
   - gems (12)
   - dragon (4)
   - dragonMundaneItems (25)
   - magicItems (33)

These are all useful DM references but lower priority than core content.

---

## NEXT STEPS

1. ✅ **Add support for `status`** - 5 entries, high value
2. ✅ **Add support for Life Module tables** - 125 entries, character creation content
3. ⚠️ **Consider `magicvariant`** - 234 entries, useful generic magic item reference
4. ⚠️ **Consider treasure tables** - 90 entries, DM convenience
5. ⚠️ **Consider `monsterTemplate`** - 63 entries, DM tool for creating variants
