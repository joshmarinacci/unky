# Release automation plan

## Goal

Automate repeatable desktop release preparation in CI while keeping publication behind an explicit human approval. A release candidate must be reviewable before it becomes public.

## Stages

1. **Release inputs and versioning** — use SemVer for the product release, a monotonically increasing CI run number for each build, and a checked-in changelog section as the source of release notes. Validate the version against `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.
2. **Candidate build** — on a manually dispatched release-candidate workflow, run the relevant tests, build supported platform packages, sign/notarize where configured, verify signatures, produce SHA-256 checksums, and upload immutable candidate artifacts plus a generated site preview. Do not publish from this stage.
3. **Human review** — review the installers, checksums, release notes, and site preview. Configure a protected GitHub Environment with required reviewers for the publish job.
4. **Approved publication** — after environment approval, create the version tag and GitHub Release, attach the reviewed installers and checksums, then deploy the generated site metadata and release notes. Keep versioned download URLs immutable and update the stable download page only at this stage.
5. **Post-release** — retain release artifacts, document rollback by restoring the previous site metadata, and keep signing credentials restricted to release jobs and protected environments.

## Implementation order

- Add release metadata and changelog validation/generation scripts.
- Split candidate packaging from publication; make publication depend on a protected environment.
- Add CI signing configuration through secrets (Apple Developer ID/notarization; Windows signing certificate or managed signing service); fail closed for production releases when required secrets are absent.
- Generate the download page from release metadata and release notes, preserving a preview artifact for review.
- Publish immutable assets and checksums to GitHub Releases; configure the site deployment target with least-privilege credentials.
- Add repository setup documentation for GitHub Environment reviewers, secrets, supported architectures, and recovery.

## GitHub production environment setup

Create a `production` Environment and require at least one human reviewer. Add these environment values:

- Secret `SITE_DEPLOY_KEY`: a dedicated SSH private key whose server account can write only to the `/unky` document directory.
- Variable `SITE_DEPLOY_HOST`: SSH host for `apps.josh.earth` (or the actual deployment host).
- Variable `SITE_DEPLOY_USER`: the restricted deployment account.
- Variable `SITE_DEPLOY_PATH`: the document root corresponding to `/unky`.
- Variable `SITE_DEPLOY_KNOWN_HOSTS`: verified SSH host-key line(s), obtained out of band and pinned; do not generate them with `ssh-keyscan` inside the workflow.

The publish workflow is started manually with the candidate run ID and version. It downloads the reviewed artifact, verifies all checksums and the three expected installers, waits for environment approval, creates the GitHub Release, copies installers without overwriting existing versioned files, and atomically replaces the page. It does not sign installers. Do not use it for a production release until the signed candidate pipeline is implemented and the environment is protected.

## Decisions still needed for a live release

- Confirm the canonical public artifact host and site deployment destination/credentials. The public page is confirmed as `https://apps.josh.earth/unky`; CI still needs a dedicated deploy credential with write access limited to this site directory.
- Provide CI signing credentials. The intended Windows release targets are ARM64 and x64; x64 packaging is being added to CI.
- Configure the GitHub `production` Environment and restricted deployment values listed above before enabling publication.

## Current implementation status

Candidate generation and the approval-gated publishing workflow are implemented. CI signing and deployment still require the external configuration listed above.
