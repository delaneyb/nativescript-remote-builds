const RemoteBuildsService = require("../services/remote-builds-service").RemoteBuildsService;

module.exports = (platform) => {
    return (hookArgs, $staticConfig, $childProcess, $fs, $logger, $cleanupService, $platformsDataService, $settingsService, $httpClient) => {
        if ((hookArgs.buildData || hookArgs.iOSBuildData).env.local
            || hookArgs.buildData.platform === 'Android'  // Always compile locally for Android
            || process.platform === 'darwin') {  // Always compile locally on MacOS
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
