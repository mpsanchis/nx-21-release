import { createProjectFileMapUsingProjectGraph, createProjectGraphAsync, logger } from '@nx/devkit';
import type { ProjectGraph } from '@nx/devkit';
import {
  releasePublish,
  releaseVersion as nxReleaseVersion,
} from 'nx/release/index.js';
import { readNxJson } from 'nx/src/config/configuration';
import { filterReleaseGroups } from 'nx/src/command-line/release/config/filter-release-groups.js';
import type { ReleaseGroupWithName } from 'nx/src/command-line/release/config/filter-release-groups.js';
import { createNxReleaseConfig } from 'nx/src/command-line/release/config/config';
import type { NxReleaseConfig } from 'nx/src/command-line/release/config/config';
import assert from 'node:assert';
import type { VersionData } from 'nx/src/command-line/release/utils/shared';
import type { VersionOptions } from 'nx/src/command-line/release/command-object';
import { gitTag, gitPush } from 'nx/src/command-line/release/utils/git';

function getPreId(): string {
  // TODO: define FORGE_PULL_REQUEST_ID
  assert(
    typeof process.env.FORGE_PULL_REQUEST_ID === 'string',
    `environment variable FORGE_PULL_REQUEST_ID is not a string (value: ${process.env.FORGE_PULL_REQUEST_ID})`
  );
  return process.env.FORGE_PULL_REQUEST_ID;
}

async function getNxReleaseConfig(projectGraph: ProjectGraph): Promise<NxReleaseConfig> {
    // Apply default configuration to any optional user configuration
  const { error: configError, nxReleaseConfig } = await createNxReleaseConfig(
    projectGraph,
    await createProjectFileMapUsingProjectGraph(projectGraph),
    readNxJson().release
  );

  if (configError) {
    console.error(configError);
    process.exit(1);
  }
  if (!nxReleaseConfig) {
    console.error('createNxReleaseConfig returned {null, null}. Check Nx implementation');
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
    console.error(filterError);
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
      (projectName: string) => projectsVersionData[projectName].newVersion !== null
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

async function releaseVersion(): Promise<VersionData> {
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

  return (await nxReleaseVersion(versionArgs)).projectsVersionData;
}

async function tagGroups(
  releaseGroups: ReleaseGroupWithName[],
  projectsVersionData: VersionData,
  options: { dryRun: boolean }
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

    if (options.dryRun) {
      logger.log(
        `[release Forge dryRun] git tag --anotate ${tag} --message "Forge tag ${tag}"`
      );
    } else {
      await gitTag({
        tag,
        message: `Forge tag ${tag}`,
      });
    }
  }
  if (options.dryRun) {
    logger.info(
      `[release Forge dryRun] git push --follow-tags --no-verify ---atomic`
    );
    return;
  }
  await gitPush({});
}

(async () => {
  const projectsVersionData = await releaseVersion();
  const releaseGroups = await getReleaseGroups();
  // TODO: what to do with gitlab releases?
  // provider/hostname not in the releaseChangelog API: read from nx.json
  // ideally called only for projects that must be published, not all

  const publishableGroups = getReleaseGroupsWithNewVersion(
    releaseGroups,
    projectsVersionData
  );

  // TODO: pass the versionData when new Nx release available
  const publishStatuses = await releasePublish({
    groups: publishableGroups.map((g) => g.name),
    dryRun: true,
  });

  const taggableGroups = getReleaseGroupsWithSuccessfulPublishes(
    publishableGroups,
    publishStatuses
  );

  await tagGroups(taggableGroups, projectsVersionData, { dryRun: true });

  process.exit(
    Object.values(publishStatuses).reduce((acc, result) => result.code + acc, 0)
  );
})().catch((e) => {
  console.error('An error occurred:', e);
});
