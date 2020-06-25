const RemoteBuildsService = require("../services/remote-builds-service").RemoteBuildsService;

module.exports = (platform) => {
    return (hookArgs, $staticConfig, $childProcess, $fs, $logger, $cleanupService, $platformsDataService, $settingsService, $httpClient) => {
        if ((hookArgs.buildData || hookArgs.iOSBuildData).env.local || /android/i.test(hookArgs.buildData.platform) || process.platform === 'darwin') {
            // let the local build
            return;
        }

        const buildService = new RemoteBuildsService({
            $staticConfig,
            $childProcess,
            $fs,
            $logger,
            $platformsDataService,
            $settingsService,
            $httpClient,
            $cleanupService,
            platform
        });

        return buildService.build.bind(buildService);
    }
}
