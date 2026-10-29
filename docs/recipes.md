# Recipes for `watcheroni exec`

`watcheroni exec -- command [args...]` runs a command for each event on
the PRs it watches. The command gets:

- the event as JSON on stdin (the format is in
  [PROTOCOL.md](../PROTOCOL.md#events));
- `WATCHERONI_KIND` (`check.failed`, `review.submitted`, ...),
  `WATCHERONI_REPO` (`octo/widgets`), `WATCHERONI_PR` (`123`),
  `WATCHERONI_URL` (the event's page on GitHub) and `WATCHERONI_EVENT_ID`
  in its environment.

With `--batch` it runs once per settled batch instead, with a JSON array
of events on stdin and their number in `WATCHERONI_COUNT`. `--on` (or
`--kinds`) picks the kinds, e.g. `--on check.*,review.submitted`;
`watch.*` kinds, such as `watch.ended` when a PR is merged or closed,
always come through.

**When the command fails.** An event is acknowledged only when the command
exits 0. Otherwise watcheroni logs

```
watcheroni: command exited 22 for comment.created (local:octo/widgets#123:comment.created:2851104761); it will be offered again
```

and runs the command for the same event again on the next poll (every 2
minutes; `--interval`), with later events waiting behind it so they stay
in order. Nothing is lost while Slack is down or the laptop is offline,
but a command that always fails holds up everything after it: exit 0 for
an event you mean to skip.

Every recipe below watches the PR for the current branch; name others
after `exec` (`octo/widgets#123` or a PR URL). Stop it with Ctrl-C.

## Desktop notification on macOS

```
npx watcheroni exec -- osascript -e 'display notification (system attribute "WATCHERONI_KIND") with title ((system attribute "WATCHERONI_REPO") & "#" & (system attribute "WATCHERONI_PR"))'
```

The notifications come from Script Editor, so allow those in System
Settings > Notifications if none show up. If `osascript` fails, the event
is offered again.

## Desktop notification on Linux

```
npx watcheroni exec -- sh -c 'notify-send "$WATCHERONI_REPO#$WATCHERONI_PR" "$WATCHERONI_KIND"'
```

`notify-send` needs your desktop session's D-Bus and a notification
daemon. Without them (over SSH, say) it fails, and the event is offered
again until it can be shown.

## A push to your phone with ntfy

Subscribe to a topic in the [ntfy](https://ntfy.sh) app; anyone who knows
its name can read it, so make it hard to guess. Then:

```
export NTFY_TOPIC=watcheroni-k3v9q2xb
npx watcheroni exec -- sh -c 'curl -fsS -o /dev/null -H "Title: $WATCHERONI_REPO#$WATCHERONI_PR" -H "Click: $WATCHERONI_URL" -d "$WATCHERONI_KIND" "https://ntfy.sh/$NTFY_TOPIC"'
```

Tapping the notification opens the event on GitHub. `-f` makes `curl`
exit non-zero when ntfy answers with an error (a rate limit, say), so the
event is offered again; so is one sent while the network is down.

## Slack

Make an [incoming webhook](https://api.slack.com/messaging/webhooks) for
the channel, and save this as `watcheroni-slack` somewhere on your `PATH`
(`chmod +x` it). It needs `jq`.

```sh
#!/bin/sh
# Posts a batch of watcheroni events to a Slack incoming webhook.
payload=$(jq -c '{text: map(
  (if .repo then .repo.full_name + (if .pr then "#\(.pr)" else "" end) else "the inbox" end) as $where
  | "\(.kind) on " + (if (.links.html // "") != "" then "<\(.links.html)|\($where)>" else $where end)
) | join("\n")}') || exit 1
curl -fsS -o /dev/null -H 'Content-Type: application/json' --data-binary "$payload" "$SLACK_WEBHOOK_URL"
```

```
export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
npx watcheroni exec --batch -- watcheroni-slack
```

With `--batch`, a review with ten comments is one message, not eleven,
which also keeps well inside Slack's limit of about one message a second.
If Slack refuses the message (a 4xx or 5xx, such as `invalid_payload` or
a rate limit) or can't be reached, the whole batch is offered again,
together with anything that arrived since.

## Only CI failures

`check.failed` arrives as soon as one check fails; `checks.completed`
once every check on the head commit has finished, with the overall
`result` (`success`, `failure` or `cancelled`) and the names of the
`failed` ones. Save this as `watcheroni-ci-failed` (`chmod +x`; it needs
`jq`) to hear about a failure straight away and about the run's result
unless it passed:

```sh
#!/bin/sh
# A notification for CI failures only.
msg=$(jq -r 'if .kind == "check.failed" then "\(.data.name) failed"
  elif .kind == "checks.completed" and .data.result != "success"
  then "Checks finished: \(.data.result) (\(.data.failed | join(", ")))"
  else empty end') || exit 1
[ -n "$msg" ] || exit 0   # checks passed, or watch.ended: nothing to say
osascript -e 'on run argv' -e 'display notification (item 2 of argv) with title (item 1 of argv)' -e 'end run' \
  "$WATCHERONI_REPO#$WATCHERONI_PR" "$msg"
# On Linux, instead: notify-send "$WATCHERONI_REPO#$WATCHERONI_PR" "$msg"
```

```
npx watcheroni exec --on check.failed,checks.completed -- watcheroni-ci-failed
```

The `jq` test exits 0 for everything else, so those events are
acknowledged and gone. If `jq` is missing it exits 1, and the events wait
rather than being dropped unseen.

## As a background service

To hear about PRs all day without a terminal open, run `exec` from your
login session's service manager on an inbox of its own, here `notify`.
Install the CLI rather than going through `npx` each time:

```
npm install -g watcheroni
```

Put the command in a script, as the services below can't take shell
quoting well. For ntfy, `~/bin/watcheroni-ntfy` (`chmod +x`):

```sh
#!/bin/sh
curl -fsS -o /dev/null -H "Title: $WATCHERONI_REPO#$WATCHERONI_PR" -H "Click: $WATCHERONI_URL" \
  -d "$WATCHERONI_KIND" "https://ntfy.sh/watcheroni-k3v9q2xb"
```

Then say which PRs the inbox watches, before starting the service:

```
watcheroni watch --inbox notify octo/widgets#123 octo/widgets#130
```

Only one process at a time can use an inbox, so to add PRs later, stop
the service, run `watcheroni watch --inbox notify ...` again, and start it
again. The service stops by itself once every PR it watches has been
merged or closed (exit 3), and the service managers below are told not to
restart it then. Nor do they after exit 1, which covers every error but a
missing GitHub login: an inbox with nothing to watch or in use by another
process, a server that refuses the inbox or keeps erroring, a crash.
Restarting won't fix those, so see the log. No GitHub login (exit 4)
restarts it after 30 seconds, in case the keychain was still locked.
An inbox with a repository-wide watch (`watcheroni watch --inbox notify
octo/widgets --kinds ...`, through the server) never exits 3, as that
watch has no end; stopping by itself is for inboxes of PRs only.

### macOS: launchd

Save as `~/Library/LaunchAgents/dev.watcheroni.notify.plist`, with `PATH`
covering where `node`, `gh` and `watcheroni` are (`command -v node gh
watcheroni`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.watcheroni.notify</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <!-- Don't restart after exit 1 (an error; see the log) or 3 (every PR has ended). -->
    <string>watcheroni exec --inbox notify -- "$HOME/bin/watcheroni-ntfy" || [ $? -le 3 ]</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardErrorPath</key>
  <string>/tmp/watcheroni-notify.log</string>
</dict>
</plist>
```

```
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.watcheroni.notify.plist   # start, and at every login
launchctl bootout gui/$(id -u)/dev.watcheroni.notify                                   # stop
tail -f /tmp/watcheroni-notify.log
```

### Linux: systemd --user

Save as `~/.config/systemd/user/watcheroni-notify.service`, with
`ExecStart` naming where `watcheroni` is (`command -v watcheroni`):

```ini
[Unit]
Description=watcheroni: pull request events to ntfy

[Service]
ExecStart=/usr/local/bin/watcheroni exec --inbox notify -- %h/bin/watcheroni-ntfy
Restart=on-failure
RestartSec=30
# 3: every PR in the inbox has been merged or closed. 143: stopped.
SuccessExitStatus=3 143
# 1: an error restarting won't fix; see the log.
RestartPreventExitStatus=1

[Install]
WantedBy=default.target
```

If `node` or `gh` aren't in `/usr/local/bin` or `/usr/bin`, add
`Environment=PATH=...` under `[Service]`.

```
systemctl --user enable --now watcheroni-notify   # start, and at every login
systemctl --user stop watcheroni-notify
journalctl --user -u watcheroni-notify -f
```

To keep it running while you're logged out, `loginctl enable-linger`.
