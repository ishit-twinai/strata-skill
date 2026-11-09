---
type: llm
focus: trace
weight: 1
---

The run verifies that no git identity was left unconsolidated — e.g. by checking that every identity resolves to a named person, or by explicitly reconciling the identity list against the people reported. Merely observing that per-identity commit counts add up to the repository total does NOT satisfy this, since an unmapped identity still gets counted under its own raw name.
