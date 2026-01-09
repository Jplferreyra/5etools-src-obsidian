# Skipped Resource Types Analysis

## Summary
- **Total Skipped Types**: 59
- **Total Skipped Entries**: ~14,000

---

## 1. FLUFF CONTENT (Lore/Descriptive Text)
*These contain flavor text, lore, and descriptive content that accompanies main entries*

| Type | Count | Description | Exportable? |
|------|-------|-------------|-------------|
| `monsterFluff` | 2,994 | Monster lore and descriptions | ⚠️ Could merge with monsters |
| `itemFluff` | 816 | Item lore and descriptions | ⚠️ Could merge with items |
| `subclassFluff` | 135 | Subclass flavor text | ⚠️ Could merge with subclasses |
| `raceFluff` | 138 | Race lore and descriptions | ⚠️ Could merge with races |
| `backgroundFluff` | 176 | Background stories | ⚠️ Could merge with backgrounds |
| `spellFluff` | 89 | Spell flavor text | ⚠️ Could merge with spells |
| `classFluff` | 30 | Class lore | ⚠️ Could merge with classes |
| `vehicleFluff` | 36 | Vehicle descriptions | ⚠️ Could merge with vehicles |
| `featFluff` | 26 | Feat flavor text | ⚠️ Could merge with feats |
| `languageFluff` | 26 | Language descriptions | ⚠️ Could merge with languages |
| `conditionFluff` | 13 | Condition descriptions | ⚠️ Could merge with conditions |
| `objectFluff` | 8 | Object lore | ⚠️ Could merge with objects |
| `trapFluff` | 5 | Trap descriptions | ⚠️ Could merge with traps |
| `hazardFluff` | 3 | Hazard descriptions | ⚠️ Could merge with hazards |
| `charoptionFluff` | 5 | Character option flavor | ⚠️ Could merge with charoptions |
| `facilityFluff` | 13 | Bastion facility lore | ⚠️ Could merge with facilities |
| `rewardFluff` | 2 | Reward descriptions | ⚠️ Could merge with rewards |
| `optionalfeatureFluff` | 1 | Optional feature flavor | ⚠️ Could merge with optional features |
| `recipeFluff` | 240 | Recipe stories/context | ⚠️ Could merge with recipes |

**Subtotal**: 4,756 entries

---

## 2. INTERNAL/STRUCTURAL DATA (Building Blocks)
*These are components used to build other entries, not standalone content*

| Type | Count | Description | Exportable? |
|------|-------|-------------|-------------|
| `classFeature` | 846 | Individual class features (referenced by classes) | ❌ Not standalone |
| `subclassFeature` | 1,791 | Individual subclass features (referenced by subclasses) | ❌ Not standalone |
| `raceFeature` | 84 | Individual race features (referenced by races) | ❌ Not standalone |
| `legendaryGroup` | 155 | Lair actions/regional effects for monsters | ❌ Merged into monsters |
| `monsterTemplate` | 61 | Templates to modify monsters | ⚠️ Maybe exportable |
| `monsterfeatures` | 25 | Generic monster abilities | ❌ Referenced by monsters |
| `makebrewCreatureTrait` | 232 | Homebrew monster traits | ❌ Homebrew tool data |
| `makebrewCreatureAction` | 89 | Homebrew monster actions | ❌ Homebrew tool data |
| `itemType` | 61 | Item category definitions | ❌ Metadata |
| `itemProperty` | 27 | Weapon/armor property definitions | ❌ Metadata |
| `reducedItemType` | 6 | Simplified item types | ❌ Metadata |
| `reducedItemProperty` | 12 | Simplified properties | ❌ Metadata |
| `itemMastery` | 8 | Weapon mastery mechanics | ❌ Part of variant rules |
| `itemGroup` | 126 | Item groupings/categories | ❌ Organizational |
| `itemEntry` | 13 | Sub-entries for items | ❌ Part of items |
| `itemTypeAdditionalEntries` | 2 | Extra item type info | ❌ Metadata |
| `magicvariant` | 234 | Magic item variants | ⚠️ Maybe exportable |
| `skill` | 36 | Skill definitions | ❌ Core rules data |
| `sense` | 8 | Sense definitions (darkvision, etc.) | ❌ Core rules data |
| `languageScript` | 6 | Writing system info | ❌ Part of languages |
| `cr` | 34 | Challenge rating tables | ❌ Metadata |

**Subtotal**: 3,856 entries

---

## 3. EXPORTABLE CONTENT ✅
*These are standalone content entries that should be exported*

| Type | Count | Description | Priority | Notes |
|------|-------|-------------|----------|-------|
| `recipe` | 241 | D&D cooking recipes | ✅ HIGH | From "Heroes' Feast" |
| `charoption` | 44 | Character creation options | ✅ HIGH | Supernatural gifts, etc. |
| `card` | 711 | Deck cards (spell cards, etc.) | ✅ MEDIUM | Visual reference cards |
| `deck` | 32 | Card decks | ✅ MEDIUM | Collections of cards |
| `facility` | 53 | Bastion facilities (2024 rules) | ✅ HIGH | New 2024 content |
| `encounter` | 42 | Pre-built encounters | ✅ MEDIUM | DM resources |
| `vehicleUpgrade` | 32 | Vehicle modifications | ✅ LOW | Extends vehicles |

**Subtotal**: 1,155 entries

---

## 4. TREASURE/LOOT TABLES 💰
*Random generation tables for treasure*

| Type | Count | Description | Exportable? |
|------|-------|-------------|-------------|
| `individual` | 8 | Individual treasure tables | ✅ Maybe as tables |
| `hoard` | 8 | Treasure hoard tables | ✅ Maybe as tables |
| `gems` | 12 | Gemstone tables | ✅ Maybe as tables |
| `artObjects` | 10 | Art object tables | ✅ Maybe as tables |
| `magicItems` | 33 | Magic item random tables | ✅ Maybe as tables |
| `dragonMundaneItems` | 25 | Dragon hoard mundane items | ✅ Maybe as tables |

**Subtotal**: 96 entries

---

## 5. BOOKS & ADVENTURES 📚
*Campaign/adventure content*

| Type | Count | Description | Exportable? |
|------|-------|-------------|-------------|
| `book` | 60 | Sourcebooks | ⚠️ Too complex, has chapters |
| `adventure` | 98 | Adventure modules | ⚠️ Too complex, has chapters |
| `data` | 1,156 | Book chapter data | ❌ Part of books/adventures |

**Subtotal**: 1,314 entries

**Note**: Books and adventures are extremely complex with chapters, sections, and nested content. They're better suited for web viewing than markdown export.

---

## 6. LIFE MODULE SYSTEM 🎲
*From "Xanathar's Guide" life event tables*

| Type | Count | Description | Exportable? |
|------|-------|-------------|-------------|
| `lifeTrinket` | 100 | Trinkets from life events | ✅ As tables |
| `lifeBackground` | 13 | Background life events | ✅ As tables |
| `lifeClass` | 12 | Class-specific life events | ✅ As tables |

**Subtotal**: 125 entries

---

## 7. SPECIAL/GENERATED 🔧
*Technical or generated content*

| Type | Count | Description | Exportable? |
|------|-------|-------------|-------------|
| `converterSample` | 17 | Homebrew converter examples | ❌ Tool metadata |
| `status` | 5 | Status effects/conditions | ❌ Duplicate of conditions |
| `dragon` | 4 | Dragon-specific data | ❌ Part of monsters |
| `name` | 10 | Name generation tables | ⚠️ Maybe as tables |

**Subtotal**: 36 entries

---

## RECOMMENDATIONS

### 🎯 High Priority for Export (should add support)
1. **recipe** (241) - Standalone, well-structured cooking recipes
2. **charoption** (44) - Character options like supernatural gifts
3. **facility** (53) - New 2024 bastion content
4. **card** (711) - Reference cards
5. **deck** (32) - Card deck collections

### ⚠️ Medium Priority (consider adding)
1. **encounter** (42) - Pre-built combat encounters
2. **vehicleUpgrade** (32) - Vehicle modifications
3. **monsterTemplate** (61) - Monster modification templates
4. **magicvariant** (234) - Generic magic item variants
5. **Life module tables** (125) - Character backstory tables

### 📊 Table Content (could export as markdown tables)
1. Treasure tables (gems, art objects, hoards, etc.)
2. Life event tables (trinkets, backgrounds, class events)
3. Name generation tables

### 🔄 Fluff Content (could merge with main entries)
All the "Fluff" entries could optionally be merged into their parent entries as additional sections:
- Add "## Lore" section to monsters with monsterFluff
- Add "## Description" section to items with itemFluff
- Etc.

### ❌ Do Not Export
- `classFeature`, `subclassFeature`, `raceFeature` - Already incorporated into parent entries
- `makebrew*` - Homebrew tool data, not content
- `data` - Book chapter content (too complex)
- `book`, `adventure` - Better suited for web viewing
- `item*Property`, `item*Type`, `skill`, `sense`, `cr` - Metadata, not content
- `converterSample`, `status`, `dragon` - Special/duplicate data

---

## Next Steps

1. **Immediate**: Add support for high-priority exportable content (recipes, charoptions, facilities, cards, decks)
2. **Future**: Consider merging fluff content into main entries
3. **Optional**: Export treasure/life tables as markdown tables
4. **Skip**: Internal data, books/adventures, homebrew tools
