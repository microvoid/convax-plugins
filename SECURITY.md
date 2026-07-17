# Security policy

Do not disclose a vulnerability in a public issue or pull request.

Report it privately through GitHub's **Security → Report a vulnerability** form for
`microvoid/convax-plugins`. Include package/version, impact, reproduction steps,
and mitigation. Do not include real user data or credentials.

Maintainers may yank a Registry item while preparing a new immutable version.
Published assets are never silently replaced. Digest mismatches, archive traversal,
sandbox escapes, host-scope widening, and workflow-token exposure are security
issues.

Convax owns runtime sandboxing and installation defenses; this repository owns
source review, deterministic packaging, published digests, and catalog integrity.
