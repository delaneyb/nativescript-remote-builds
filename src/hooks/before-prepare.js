module.exports = (hookArgs) => {
    if (hookArgs.prepareData.env.local || /android/i.test(hookArgs.prepareData.platform) || process.platform === 'darwin') {
        // local build
        return;
    }

    hookArgs.prepareData = hookArgs.prepareData || {};
    hookArgs.prepareData.nativePrepare = hookArgs.prepareData.nativePrepare || {};
    hookArgs.prepareData.nativePrepare.skipNativePrepare = true;
}
