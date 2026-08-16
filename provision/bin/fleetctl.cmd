@echo off
rem fleetctl - Windows shim so the CLI is a command, not a path. The hints printed by every
rem lane ("fleetctl set-secrets <agent>") are then literally runnable. Node is required; the
rem script lives next to this file, so a moved or copied checkout keeps working.
node "%~dp0fleetctl.js" %*
