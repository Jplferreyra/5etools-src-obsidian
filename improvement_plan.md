# D&D 5etools Markdown Export - Improvement Plan

## 📊 Progress Tracker

### Batch 1 - The Essentials (Priority 1)
- [x] **Spells** - Add available classes, higher-level spell slots info ✅
- [x] **Items** - Add item type, fix missing descriptions ✅
- [x] **Feats** - Add type, origin, fighting style properties ✅
- [ ] **Species/Races** - Add sub-races support
- [ ] **Monsters** - Investigate and fix reported issues

### Batch 2 - Character Creation (Priority 2-3)
- [ ] **Classes** - Improve poor output quality
- [ ] **Subclasses** - Implement proper formatting
- [ ] **Actions** - Implement proper formatting
- [ ] **Optional Features** - Implement proper formatting

### Batch 3 - Reference & Rare (Priority 4-5)
- [ ] **Tables** - Implement proper formatting
- [ ] **Languages** - Add type and description
- [ ] **Deities** - Implement proper formatting
- [ ] **Rewards** - Add type property
- [ ] **Objects** - Add AC and other stats
- [ ] **Vehicles** - Implement proper formatting
- [ ] **Psionics** - Implement proper formatting
- [ ] **Variant Rules** - Implement proper formatting

### Already Working ✅
- ✅ **Backgrounds** - Working correctly
- ✅ **Conditions** - Working correctly
- ✅ **Cult-Boons** - Working correctly
- ✅ **Traps** - Working correctly

---

## 📋 Detailed Fix Plans

### ✅ WORKING (No fixes needed) - 4 types

  1. Backgrounds - OK
  2. Conditions - OK
  3. Cult-Boons - OK
  4. Traps - OK

  ---
  🔴 PRIORITY 1: Most Used Resources - 5 types

  1. Spells - Missing classes and higher-level info

  Issues:
  - Missing available classes list
  - Missing higher-level spell slot scaling info

  Fix Plan:
  - Add classes array to frontmatter (wizard, cleric, etc.)
  - Add "At Higher Levels" section formatting
  - Add spell list tags (e.g., wizard-spell, cleric-spell)

  2. Items - Missing type and descriptions

  Issues:
  - Missing item type in frontmatter/content
  - Some items have no description

  Fix Plan:
  - Add item type prominently (weapon, armor, wondrous item, etc.)
  - Check if description comes from entries or needs special handling
  - Add weapon/armor properties tables

  3. Feats - Missing type, origin, fighting style

  Issues:
  - Missing type (general, origin, fighting style, etc.)
  - Missing prerequisite details

  Fix Plan:
  - Add feat category/type to frontmatter
  - Format prerequisites prominently
  - Handle special feat types (Fighting Style, Origin feats)

  4. Species/Races - Missing sub-races

  Issues:
  - Sub-races not showing up

  Fix Plan:
  - Handle race variants/subraces properly
  - Link to parent race if subrace
  - Show all racial traits

  5. Monsters - Issues reported

  Issues:
  - Need to investigate specific problems (what's broken?)

  Fix Plan:
  - Test specific monsters to find issues
  - May need to handle special monster types

  ---
  🟡 PRIORITY 2: Character Creation - 2 types

  6. Classes - Poor quality

  Issues:
  - Current output is "poor"
  - Missing detailed information

  Fix Plan:
  - Add class table (level progression)
  - Add multiclassing requirements
  - Better feature descriptions
  - Add starting equipment

  7. Subclasses - Not implemented

  Issues:
  - No proper formatting

  Fix Plan:
  - Link to parent class
  - Show subclass features by level
  - Handle subclass-specific spells

  ---
  🟠 PRIORITY 3: Gameplay Resources - 3 types

  8. Actions - Not working

  Fix Plan:
  - Format action time (action, bonus action, reaction)
  - Show action description

  9. Optional Features - Not working

  Fix Plan:
  - Show feature type (Fighting Style, Eldritch Invocation, etc.)
  - Prerequisites
  - Link to parent class/feature

  10. Variant Rules - Not working

  Fix Plan:
  - Format rules text properly
  - Categorize by type

  ---
  🟢 PRIORITY 4: Reference Resources - 4 types

  11. Tables - Not working

  Fix Plan:
  - Render tables properly in markdown
  - Handle dice tables, encounter tables, etc.

  12. Languages - Missing type and description

  Fix Plan:
  - Add language type (standard, exotic, secret)
  - Add script information

  13. Deities - Not working

  Fix Plan:
  - Add pantheon, alignment, domains
  - Add symbol/holy symbol
  - Format properly

  14. Rewards - Missing type

  Fix Plan:
  - Add reward type (Supernatural Gift, Blessing, Charm, etc.)

  ---
  🔵 PRIORITY 5: Less Common Resources - 4 types

  15. Objects - Missing AC and stats

  Fix Plan:
  - Add AC, HP, damage threshold
  - Add object size and properties

  16. Vehicles - Not working

  Fix Plan:
  - Add vehicle stats (speed, AC, HP, crew)
  - Handle different vehicle types (land, water, air)

  17. Psionics - Not working

  Fix Plan:
  - Format psionic disciplines/talents
  - Show psi point costs

  18. Vehicles - Not working

  Fix Plan:
  - See Priority 5 above

  ---
  Recommended Approach

  I suggest we tackle them in 3 batches:

  Batch 1 (Do Now) - The Essentials

  - Spells (enhancement)
  - Items
  - Feats
  - Species/Races
  - Monsters (investigation)

  Batch 2 (Next) - Character Creation

  - Classes (improvement)
  - Subclasses
  - Actions
  - Optional Features

  Batch 3 (Later) - Reference & Rare

  - Everything else (Tables, Languages, Deities, Rewards, Objects, Vehicles, Psionics, Variant Rules)

  ---
  Should I start with Batch 1? I'll fix each one systematically, test it, and show you the results before moving to the next. Let me know if you want to start, or if you
  want to adjust the priority order!
