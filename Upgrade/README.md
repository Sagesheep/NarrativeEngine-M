# mobileApp Upgrade Plan: Feature Parity with mainApp

## Purpose
This folder contains a phased upgrade plan to bring mobileApp to feature parity with mainApp.
Each phase file is self-contained with explicit instructions, code references, and file paths.

## For AI Coders
- Read each phase file IN ORDER from Phase 0 to Phase 10
- Each file tells you EXACTLY which files to read, what to add, and what to change
- Reference the mainApp source at `../mainApp/` for the canonical implementation
- DO NOT skip phases - later phases depend on earlier ones
- After each phase, verify the app compiles with `npm run build`

## Current State
mobileApp already has ~80% feature parity. The gaps are:

| Area | Status | Gap |
|------|--------|-----|
| Types | 95% | Missing 4 types + 3 fields |
| Services | 70% | 2 files missing entirely, 3 files need major upgrades |
| Server.js | 60% | Missing 13 endpoints, atomic writes, chapter lifecycle |
| Store | 75% | Missing chapters/facts/backup state and actions |
| Components | 70% | Missing 3 components, 5 components need upgrades |
| turnOrchestrator | 60% | Missing parallel gathering, chapter funnel, abort detection |

## Phase Overview

| Phase | Name | New Files | Modified Files | Est. Lines |
|-------|------|-----------|----------------|------------|
| 0 | Types & Dependencies | 0 | 1 | ~50 |
| 1 | Server Backend | 0 | 1 | ~660 |
| 2 | Semantic Memory Service | 1 | 0 | ~120 |
| 3 | Archive Chapter Engine | 1 | 0 | ~250 |
| 4 | Save File Engine Upgrade | 0 | 1 | ~250 |
| 5 | Archive Memory Upgrade | 0 | 1 | ~130 |
| 6 | Store Layer Upgrades | 0 | 5 | ~100 |
| 7 | Condenser & Orchestrator | 0 | 2 | ~120 |
| 8 | New Components | 3 | 1 | ~450 |
| 9 | Component Upgrades | 0 | 7 | ~300 |
| 10 | Integration & Testing | 0 | 1 | ~20 |

**Total estimated: ~2,350 lines of changes across ~20 files**

## Key Reference Paths
- mobileApp source: `D:\Games\AI DM Project\Automated_system\mobileApp\src\`
- mainApp source: `D:\Games\AI DM Project\Automated_system\mainApp\src\`
- mainApp server: `D:\Games\AI DM Project\Automated_system\mainApp\server.js`
- mobileApp server: `D:\Games\AI DM Project\Automated_system\mobileApp\server.js`

## CRITICAL RULES
1. **DO NOT change mobileApp's persistence layer** - it uses idb-keyval + server API hybrid. Keep it.
2. **DO NOT remove mobileApp-only features** - AI Players (enemy/neutral/ally), MobileNavBar, bottom sheet, touch targets, UI scale
3. **DO NOT change mobileApp's styling approach** - keep Tailwind + existing CSS
4. **Port mainApp features TO mobileApp patterns** - adapt, don't copy-paste
5. **All new server endpoints must work with existing Express server** on port 3001
6. **Keep mobileApp's sequential context gathering** for now (parallel is a future optimization)
