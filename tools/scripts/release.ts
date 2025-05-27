import {
  createProjectFileMapUsingProjectGraph,
  createProjectGraphAsync,
  logger as devkitLogger,
} from '@nx/devkit';
import type { ProjectGraph } from '@nx/devkit';
import {
  releasePublish,
  releaseVersion as nxReleaseVersion,
} from 'nx/release/index.js';
import { readNxJson } from 'nx/src/config/configuration.js';
import { filterReleaseGroups } from 'nx/src/command-line/release/config/filter-release-groups.js';
import type { ReleaseGroupWithName } from 'nx/src/command-line/release/config/filter-release-groups';
import { createNxReleaseConfig } from 'nx/src/command-line/release/config/config.js';
import type { NxReleaseConfig } from 'nx/src/command-line/release/config/config';
import assert from 'node:assert';
import type { VersionData } from 'nx/src/command-line/release/utils/shared';
import type { VersionOptions } from 'nx/src/command-line/release/command-object';
import { gitTag, gitPush } from 'nx/src/command-line/release/utils/git.js';

const logger = {
  verbose: (verbosity?: boolean) => ({
    log: verbosity
      ? (msg: string) => devkitLogger.log(`[FORGE release] ${msg}`)
      : () => {},
    error: verbosity
      ? (msg: string) => devkitLogger.error(`[FORGE release] ${msg}`)
      : () => {},
  }),
};

function getPreId(): string {
  assert(
    typeof process.env.FORGE_PULL_REQUEST_SOURCE_BRANCH_NAME === 'string',
    `environment variable FORGE_PULL_REQUEST_SOURCE_BRANCH_NAME is not a string (value: ${process.env.FORGE_PULL_REQUEST_ID})`
  );
  return process.env.FORGE_PULL_REQUEST_SOURCE_BRANCH_NAME;
}

async function getNxReleaseConfig(
  projectGraph: ProjectGraph
): Promise<NxReleaseConfig> {
  // Apply default configuration to any optional user configuration
  const { error: configError, nxReleaseConfig } = await createNxReleaseConfig(
    projectGraph,
    await createProjectFileMapUsingProjectGraph(projectGraph),
    readNxJson().release
  );

  if (configError) {
    logger.verbose(true).error(JSON.stringify(configError));
    process.exit(1);
  }
  if (!nxReleaseConfig) {
    logger
      .verbose(true)
      .error(
        'createNxReleaseConfig returned {null, null}. Check Nx implementation'
      );
    process.exit(1);
  }

  return nxReleaseConfig;
}

async function getReleaseGroups(): Promise<ReleaseGroupWithName[]> {
  const projectGraph = await createProjectGraphAsync({ exitOnError: true });
  const nxReleaseConfig = await getNxReleaseConfig(projectGraph);

  const {
    error: filterError,
    filterLog,
    releaseGroups,
  } = filterReleaseGroups(projectGraph, nxReleaseConfig);
  if (filterError) {
    logger.verbose(true).error(JSON.stringify(filterError));
    process.exit(1);
  }
  if (filterLog) {
    console.log(filterLog);
  }
  return releaseGroups;
}

function getReleaseGroupsWithNewVersion(
  releaseGroups: ReleaseGroupWithName[],
  projectsVersionData: VersionData
): ReleaseGroupWithName[] {
  return releaseGroups.filter((releaseGroup) =>
    releaseGroup.projects.some(
      (projectName: string) =>
        projectsVersionData[projectName].newVersion !== null
    )
  );
}

function getReleaseGroupsWithSuccessfulPublishes(
  releaseGroups: ReleaseGroupWithName[],
  publishStatuses: Awaited<ReturnType<typeof releasePublish>>
): ReleaseGroupWithName[] {
  return releaseGroups.filter((releaseGroup) =>
    releaseGroup.projects.some(
      (projectName: string) => publishStatuses[projectName].code === 0
    )
  );
}

async function releaseVersion(verbose: boolean): Promise<VersionData> {
  const versionArgs: VersionOptions = {
    stageChanges: false,
    gitCommit: false,
    gitTag: false,
  };
  // When not in main/fix branches, add a preId to release a pre-release
  if (
    typeof process.env.FORGE_IS_PULL_REQUEST !== 'undefined' ||
    typeof process.env.FORGE_IS_MERGE_QUEUE !== 'undefined'
  ) {
    versionArgs.preid = getPreId();
  }

  const projectsVersionData = (await nxReleaseVersion(versionArgs))
    .projectsVersionData;

  logger.verbose(verbose).log(
    `versions:\n${Object.entries(projectsVersionData)
      .map(([projectName, { currentVersion, newVersion }]) =>
        newVersion
          ? `${projectName}: ${newVersion} (new)`
          : `${projectName}: ${currentVersion} (old)`
      )
      .join('\n')}`
  );

  return projectsVersionData;
}

async function tagGroups(
  releaseGroups: ReleaseGroupWithName[],
  projectsVersionData: VersionData,
  options?: { dryRun?: boolean; verbose?: boolean }
) {
  for (const releaseGroup of releaseGroups) {
    const groupVersionData = releaseGroup.projects
      .map((projectName: string) => projectsVersionData[projectName])
      .find((data: any) => typeof data?.newVersion === 'string');

    assert(
      groupVersionData,
      `Could not find any project belonging to release group: ${releaseGroup.name}`
    );
    const tag = releaseGroup.releaseTagPattern.replaceAll(
      '{version}',
      groupVersionData.newVersion
    );

    logger
      .verbose(options?.verbose)
      .log(`git tag --anotate ${tag} --message "Forge tag ${tag}"`);
    if (!options?.dryRun) {
      await gitTag({
        tag,
        message: `Forge tag ${tag}`,
      });
    }
  }

  logger
    .verbose(options?.verbose)
    .log(`git push --follow-tags --no-verify ---atomic`);

  if (!options?.dryRun) {
    await gitPush({});
  }
  return;
}

(async () => {
  const verbose = true;

  const projectsVersionData = await releaseVersion(verbose);
  const releaseGroups = await getReleaseGroups();
  // TODO: what to do with gitlab releases?
  // provider/hostname not in the releaseChangelog API: read from nx.json
  // ideally called only for projects that must be published, not all

  const publishableGroups = getReleaseGroupsWithNewVersion(
    releaseGroups,
    projectsVersionData
  );

  if (publishableGroups.length === 0) {
    logger
      .verbose(true)
      .log(`No release groups have been bumped. Nothing to publish.`);
    process.exit(0);
  }

  logger.verbose(verbose).log(`groups to publish:\n
    ${publishableGroups.map((group) => `${group.name}`).join('\n')}
  `);

  // TODO: pass the versionData when new Nx release available
  const publishStatuses = await releasePublish({
    groups: publishableGroups.map((g) => g.name),
  });

  const taggableGroups = getReleaseGroupsWithSuccessfulPublishes(
    publishableGroups,
    publishStatuses
  );

  await tagGroups(taggableGroups, projectsVersionData, { verbose, dryRun: true });

  process.exit(
    Object.values(publishStatuses).reduce((acc, result) => result.code + acc, 0)
  );
})().catch((e) => {
  logger.verbose(true).error(`An error occurred: ${JSON.stringify(e)}`);
});
