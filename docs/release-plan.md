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

## Decisions still needed for a live release

- Confirm the canonical public artifact host and site deployment destination/credentials. The public page is confirmed as `https://apps.josh.earth/unky`; CI still needs a dedicated deploy credential with write access limited to this site directory.
- Provide CI signing credentials. The intended Windows release targets are ARM64 and x64; x64 packaging is being added to CI.
- Configure the GitHub `production` Environment with required reviewers before enabling publication.

## Current implementation status

The repo is beginning with the version/changelog validation and release metadata generation pieces. CI publication and cloud signing require the external configuration listed above.
