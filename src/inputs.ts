import * as core from '@actions/core'
import type { Inputs } from './types'

// Parse and normalize action inputs, including the legacy `extra_args` alias.
export function getInputs(): Inputs {
  const legacyExtraArgs = core.getInput('extra_args')
  const modernExtraArgs = core.getInput('extra-args')
  const version = core.getInput('version')
  const legacyVersion = core.getInput('prek-version')
  if (version && legacyVersion && version !== legacyVersion) {
    throw new Error('version and prek-version have different values. Set only version.')
  }
  return {
    cache: core.getBooleanInput('cache'),
    extraArgs: legacyExtraArgs || modernExtraArgs,
    installOnly: core.getBooleanInput('install-only'),
    prekVersion: version || legacyVersion,
    showVerboseLogs: core.getBooleanInput('show-verbose-logs'),
    versionFile: core.getInput('version-file'),
    workingDirectory: core.getInput('working-directory') || '.',
  }
}
