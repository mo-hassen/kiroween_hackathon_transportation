KIROWEEN HACKA TRANSPORTATION — AI PROMPT PLAYBOOK

This folder contains the phased prompts for building the Addis Ababa vehicle-owner/driver mobility platform.

IMPORTANT:
Do not paste every prompt into Kiro at once.

Recommended workflow:
1. Put this folder inside the project repository as /ai-prompts.
2. Give Kiro 00_MASTER_PROJECT_BRIEF.txt first.
3. Ask Kiro to read 01_ARCHITECTURE_AND_SPECIFICATION.txt and produce the architecture before implementation.
4. Review the architecture.
5. Implement phases in order.
6. After each phase, require formatting, static analysis, tests and a written verification report.
7. Use the security audit before calling the application production-ready.
8. Use the final production readiness audit before any real-world pilot.

MODEL STRATEGY:
Use Claude Opus 5.5 with high reasoning effort for:
- architecture
- security
- identity integration
- financial ledger
- concurrency
- difficult backend work
- final security/production audits

Use a lower-cost model such as Sonnet for:
- straightforward UI
- small refactors
- simple tests
- routine bug fixes
- documentation updates

The prompts intentionally avoid inventing government or payment APIs. External integrations should be implemented only from official provider documentation and credentials/sandboxes.

PROJECT CORE:
Verified owner -> verified vehicle -> verified driver -> marketplace -> application -> agreement -> assignment -> activity -> earnings -> settlement -> payout -> dispute/support.
