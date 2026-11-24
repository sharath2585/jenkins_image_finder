# Jenkins Image Finder

A local Chrome/Edge extension with a web UI. Find a Docker image's Jenkins build,
branch, commit, and matching console evidence using your existing Jenkins login.
No server, npm install, password entry, API token, or external service is needed.

## Install and use

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**, choose **Load unpacked**, and select this folder.
   If Chrome/Edge runs on a different computer, copy this entire folder there first.
3. Open Jenkins in that browser and sign in normally.
4. While viewing the Jenkins tab, click the **Jenkins Image Finder** extension icon.
   Pin the icon through the browser's Extensions menu if needed.
5. In the new finder tab, enter a job/folder URL and an image reference or tag.
6. Click **Find image**. Keep the original Jenkins tab open.

Example:

- Job: `http://10.113.145.155/job/bms-orchestrator/`
- Image: `bms-orchestrator-service:20260820144606`
- Expected match: `hotfix/patch_gp_25136`, build `8`
- Commit: `5795256031bd8ed17f5730474c8d9431896be925`

The URL can point to a normal job, a multibranch pipeline, a branch job, or a
folder containing jobs. To search another Jenkins server, launch the extension
again from a signed-in tab on that server.

## Results and search limits

- Image references match exact tokens or path suffixes, not tag prefixes.
  A tag alone matches any image with that exact tag; use the image name to narrow it.
- Timestamp-shaped tags prioritize nearby builds. No timezone assumption excludes
  a build: all discovered retained builds remain candidates.
- The first match may only reference an image built elsewhere. **Push command
  recorded** means a matching `docker push`/`podman push` command appeared, not
  independent proof that the push succeeded. Check build status and log evidence.
- Branch/commit values come from Jenkins console checkout and `Branch -` entries.
  If no unambiguous checkout exists, the commit is left unknown. A fallback branch
  taken from the job name is explicitly marked as inferred.
- Default: stop after the first match or 200 console logs. Disable the first-match
  option and raise the limit (up to 5,000) for a broader search.
- Discovery is limited to 500 jobs and 10,000 builds. API responses are limited to
  4 MB, console logs to 8 MB, and each request to 30 seconds. Oversized, inaccessible,
  or failed requests are reported as incomplete, never silently counted as searched.
- **Stop search** takes effect after the current request, within its 30-second timeout.
- Deleted builds, discarded logs, or builds you cannot access cannot be traced.
  A partial search with no match is not proof that an image does not exist.

## Privacy and browser requirements

The extension requests only `activeTab` and `scripting`, not access to every site.
Clicking its icon grants temporary access to the tab you select. Requests execute
in that tab against the same Jenkins origin, so browser cookies stay in the browser.
The extension does not read/export cookies, save credentials, persist results, or
send data to a third party. Closing the finder tab discards its results.

Your Jenkins login in VS Code's integrated browser is separate from Chrome/Edge.
Sign in in the browser where you install this extension. An organization policy
that disables unpacked extensions will require administrator approval.

## Development

Vanilla JavaScript modules, HTML, and CSS; no dependencies or build step.

```sh
node tests.mjs
```

After changing files, reload the extension in the browser's Extensions page and
launch a new finder tab. The browser UI uses modern Chrome/Edge extension APIs;
the dependency-free search tests can also run on Node 12.
