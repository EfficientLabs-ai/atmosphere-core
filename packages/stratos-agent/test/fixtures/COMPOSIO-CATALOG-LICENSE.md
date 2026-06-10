# Provenance & License — `composio-catalog.ci.json`

`composio-catalog.ci.json` is a **trimmed CI fixture derived from the Composio open-source toolkit
catalog** (`ComposioHQ/composio`). `gen-composio-ci-catalog.mjs` produces it from the upstream
`toolkits.json` by keeping every toolkit's metadata (slug, name, category, auth schemes, tool count)
and the full per-action `tools` list only for the toolkits the hermetic test exercises (`github`,
`gmail`, `slack`). No upstream code is included — only catalog data — and it is used solely as test
input so CI can run `test-composio-sovereign.mjs` without the full (~17 MB, gitignored) catalog.

Upstream source: <https://github.com/ComposioHQ/composio> — licensed **MIT**. The full upstream
license is reproduced below as required by the MIT terms (the copyright notice must be included in
copies or substantial portions).

---

MIT License

Copyright (c) 2025 Sampark Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
