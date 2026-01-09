# Export Expansion - High-Level Plan

## Step 1: Folder Structure Reorganization & Renaming ✅ COMPLETE

### Implemented Structure
```
markdown-export/
├── Actions/
├── Backgrounds/
├── Bestiary/                             ✅ renamed from Monsters
├── Classes/                              ✅ HIERARCHICAL STRUCTURE
│   ├── Barbarian/
│   │   ├── Barbarian (PHB).md
│   │   ├── Barbarian (XPHB).md
│   │   └── Subclasses/
│   │       ├── Path of the Berserker (PHB).md
│   │       ├── Path of the Beast (TCE).md
│   │       └── ... (14 subclasses)
│   ├── Bard/
│   ├── Cleric/
│   └── ... (17 total class folders)
├── Cults Boons/
├── Deities/
├── Feats/
├── Items/
├── Languages/
├── Objects/
├── Optional Features/
├── Psionics/
├── Races/
├── Rewards/
├── Rules/                                ✅ NEW
│   ├── Conditions/                       ✅ moved from root
│   └── Variant Rules/                    ✅ moved from root
├── Spells/
├── Tables/
├── Traps Hazards/
└── Vehicles/
```

### Completed Tasks
- ✅ Updated TAG_TO_DIR_MAP with capitalized folder names
- ✅ Implemented class/subclass hierarchical folder structure
- ✅ Updated wikilink generation for all new paths
- ✅ Updated hardcoded wikilinks (weapon properties, mastery)
- ✅ Ran full export: 10,539 files updated, 0 errors
- ✅ Verified folder structure and wikilinks

### Wikilink Examples
```markdown
Classes: [[Classes/Barbarian/Barbarian (PHB)|Barbarian (PHB)]]
Subclasses: [[Classes/Barbarian/Subclasses/Path of the Berserker (PHB)|Path of the Berserker (PHB)]]
Conditions: [[Rules/Conditions/Charmed (PHB)|Charmed (PHB)]]
Variant Rules: [[Rules/Variant Rules/Grappling (PHB)|Grappling (PHB)]]
Weapon Properties: [[Rules/Weapon Properties/Versatile (XPHB)|Versatile (XPHB)]]
```

---

## Step 2: Fix Missing Subclass Features ✅ COMPLETE

### Issue (Resolved)
Some subclasses referenced features but didn't include the feature descriptions. They mentioned new features/abilities but the content was missing.

**Example:** Path of the Wild Heart (Barbarian)
- Level 3 showed "Barbarians who follows..." intro text only
- Missing feat descriptions: "Animal Speaker" and "Rage of the Wilds"
- Only showed intro, not the actual mechanics

### Root Cause
Feature entries contained `refSubclassFeature` and `refClassFeature` type objects that referenced other features. These references were being passed directly to the renderer, which didn't know how to handle them, so they appeared as empty content.

### Solution Implemented
Created `_expandFeatureRefs()` method that:
1. Walks through feature entries before rendering
2. Detects `type: "refSubclassFeature"` and `type: "refClassFeature"` entries
3. Looks up the referenced features using `_findSubclassFeature()` or `_findClassFeature()`
4. Replaces references with actual feature content as nested entries
5. Applied to both class and subclass feature rendering

### Results
- ✅ Path of the Wild Heart now shows Animal Speaker and Rage of the Wilds features
- ✅ Full export completed: 10,539 files updated, 0 errors
- ✅ All sub-features now render with proper headings and descriptions
- ✅ Works for both classes and subclasses

---

## Step 3: Game Mechanics & Vehicle Resources ✅ COMPLETE

### Resources Exported

| Resource Type | Folder | Data File | Files Exported |
|---------------|--------|-----------|----------------|
| **sense** | Rules/Senses/ | senses.json | 8 |
| **status** | Rules/Conditions/ | conditionsdiseases.json | 5 |
| **itemProperty** | Rules/Weapon Properties/ | items-base.json | 27 |
| **itemMastery** | Rules/Weapon Mastery/ | items-base.json | 8 |
| **vehicleUpgrade** | Vehicles/Vehicle Upgrades/ | vehicles.json | 31 |
| **facility** | Facilities/ | bastions.json | 53 |

**Total: 132 new files exported**

### Implementation Details

**Confirmed weapon-specific:**
- itemProperty and itemMastery are weapon-specific
- Using "Weapon Properties" and "Weapon Mastery" folder names ✓

**Special handling added:**
- itemProperty entries have nested names (`entries[0].name`)
- Fixed filename generation in `exportEntry()`
- Fixed frontmatter name generation in `_generateBase()`

**Completed:**
- ✅ Located all 6 data files
- ✅ Added to RESOURCE_TYPE_MAP
- ✅ Implemented 6 formatter methods
- ✅ Fixed itemProperty name extraction
- ✅ Full export: 10,672 files (up from 10,539)
- ✅ All wikilinks working correctly

### Step 3 Refinements ✅ COMPLETE

**Issues Fixed:**
1. **Status folder merge** - Merged Rules/Status/ into Rules/Conditions/
2. **Vehicle upgrade type codes** - Decoded cryptic codes (IWM:W → "Infernal War Machine - Weapon")
3. **Missing facility data** - Added Prerequisites, Hirelings, and Available Orders fields

**Vehicle Upgrade Type Decoding:**
- Created `_decodeVehicleUpgradeType()` method
- Decodes PREFIX:SUFFIX format (e.g., "IWM:W", "SHP:F")
- Vehicle types: IWM = Infernal War Machine, SHP = Ship
- Upgrade categories: W = Weapon, A = Armor, F = Figurehead, H = Hull, M = Movement, G = Gadget, O = Other
- Example output: "**Upgrade Type:** Infernal War Machine - Weapon"

**Facility Export Enhancements:**
- Added **Prerequisites** field (facility requirements, level requirements)
- Added **Hirelings** field (exact count or ranges: "1", "2-4", "3+", "up to 5")
- Added **Available Orders** field (Empower, Trade, etc.)
- Verified all 53 facilities export with complete information

**Final Results:**
- ✅ Full export: 10,672 files, 0 errors
- ✅ Rules/Status folder removed (merged into Conditions)
- ✅ All vehicle upgrades show human-readable types
- ✅ All facilities show complete bastion mechanics
- ✅ No additional bastion-related resource types found

---

## Steps 4-5: Tables & Character Options ⏸️ PENDING

To be defined after Step 3 refinements complete.
