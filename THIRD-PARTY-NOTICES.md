# Third-Party Notices

ai-engkit's own code is licensed under the MIT License (see [LICENSE](./LICENSE)).
That license covers **this project's own code only**. It does not relicense any
third-party component listed below, and it cannot grant rights the project does
not hold.

This file lists the third-party components that are **bundled, vendored, or
derived from** in this repository or in the container image it builds, together
with the license terms those components require us to pass on. Components that
are merely installed by a package manager at build time (apt, npm, Go, or
prebuilt binaries) are distributed under their own licenses; the complete
inventory is the `Dockerfile` plus the package-manager metadata of the image.

## Summary

| Component | Source / version | License | How it is used here |
|---|---|---|---|
| oh-my-openagent (a.k.a. oh-my-opencode) | code-yeongyu — npm `oh-my-openagent` 4.19.4 | **Sustainable Use License 1.0** (not OSI open source) | V1 line only. Declared as an OpenCode plugin; OpenCode installs it at runtime from npm. **Not bundled in the image.** The V1 image also carries `.opencode/omo.jsonc.default`, a derived copy of its default configuration; the V2 image carries neither. |
| superpowers | github.com/obra/superpowers | MIT | Cloned at image build time into `/opt/opencode/baked-plugins/superpowers`. |
| @code-yeongyu/comment-checker | 0.8.x | MIT | Installed globally in the image. |
| karpathy-guidelines | ai-engkit baked skill, derived from Andrej Karpathy's public observations | MIT | Ships in `.opencode/baked-skills/karpathy-guidelines/`. |

## oh-my-openagent — Sustainable Use License 1.0

Copyright (c) code-yeongyu. The full license text is reproduced below because
the license requires that anyone who receives a copy of the software also
receives these terms.

### How ai-engkit uses it, and what is modified

- **Not bundled.** ai-engkit does **not** include oh-my-openagent source or
  binaries in its image. On the V1 line, the generated `opencode.json` declares
  `plugin: ["oh-my-openagent@4.19.4"]` and the OpenCode runtime installs the
  package itself from npm into the user's own container.
- **Modified / derived configuration (V1 image only).** `.opencode/omo.jsonc.default`
  is a curated, modified copy of oh-my-openagent's default agent configuration
  (agent roster, per-agent permission matrix, and model-chain defaults). On the
  V1 line it is written into the image at `/etc/opencode/omo.jsonc.default` and
  merged at container start into `~/.omo/omo.jsonc` by
  `entrypoint.d/02-init-config.sh`. **This derived file is provided under the
  Sustainable Use License 1.0, not under ai-engkit's MIT License.**
- **The V2 line carries none of it.** When `OMO_ENABLED=0`, nothing installs or
  loads oh-my-openagent; the V2 image omits the derived default config entirely
  (the Dockerfile writes it only when the V1 CLI is in use) and its
  `opencode.json` declares an empty plugin list. No oh-my-openagent-derived
  content ships on the V2 line.

### Sustainable Use License

Version 1.0

#### Acceptance

By using the software, you agree to all of the terms and conditions below.

#### Copyright License

The licensor grants you a non-exclusive, royalty-free, worldwide,
non-sublicensable, non-transferable license to use, copy, distribute, make
available, and prepare derivative works of the software, in each case subject to
the limitations below.

#### Limitations

You may use or modify the software only for your own internal business purposes
or for non-commercial or personal use. You may distribute the software or
provide it to others only if you do so free of charge for non-commercial
purposes. You may not alter, remove, or obscure any licensing, copyright, or
other notices of the licensor in the software. Any use of the licensor's
trademarks is subject to applicable law.

#### Patents

The licensor grants you a license, under any patent claims the licensor can
license, or becomes able to license, to make, have made, use, sell, offer for
sale, import and have imported the software, in each case subject to the
limitations and conditions in this license. This license does not cover any
patent claims that you cause to be infringed by modifications or additions to
the software. If you or your company make any written claim that the software
infringes or contributes to infringement of any patent, your patent license for
the software granted under these terms ends immediately. If your company makes
such a claim, your patent license ends immediately for work on behalf of your
company.

#### Notices

You must ensure that anyone who gets a copy of any part of the software from you
also gets a copy of these terms. If you modify the software, you must include in
any modified copies of the software a prominent notice stating that you have
modified the software.

#### No Other Rights

These terms do not imply any licenses other than those expressly granted in
these terms.

#### Termination

If you use the software in violation of these terms, such use is not licensed,
and your license will automatically terminate. If the licensor provides you with
a notice of your violation, and you cease all violation of this license no later
than 30 days after you receive that notice, your license will be reinstated
retroactively. However, if you violate these terms after such reinstatement, any
additional violation of these terms will cause your license to terminate
automatically and permanently.

#### No Liability

As far as the law allows, the software comes as is, without any warranty or
condition, and the licensor will not be liable to you for any damages arising out
of these terms or the use or nature of the software, under any kind of legal
claim.

#### Definitions

The "licensor" is the entity offering these terms.

The "software" is the software the licensor makes available under these terms,
including any portion of it.

"You" refers to the individual or entity agreeing to these terms.

"Your company" is any legal entity, sole proprietorship, or other kind of
organization that you work for, plus all organizations that have control over,
are under the control of, or are under common control with that organization.
Control means ownership of substantially all the assets of an entity, or the
power to direct its management and policies by vote, contract, or otherwise.
Control can be direct or indirect.

"Your license" is the license granted to you for the software under these terms.

"Use" means anything you do with the software requiring your license.

"Trademark" means trademarks, service marks, and similar rights.

## MIT components

The MIT-licensed third-party components bundled or derived from are:

- **superpowers** — Copyright (c) its authors (github.com/obra/superpowers)
- **@code-yeongyu/comment-checker** — Copyright (c) code-yeongyu
- **karpathy-guidelines** — derived from Andrej Karpathy's publicly shared
  observations, as declared `license: MIT` in its `SKILL.md`

They are distributed under the following terms:

```text
MIT License

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
```
