const sshMachineService = require('./src/services/remotes/ssh-machine-service').SSHMachineService

const buildService = new sshMachineService(null, null, null, 'ios', {}, {
    "machines": ["ben-mbp", "10.42.0.2", "192.168.1.198"],
    "sshUser": "ben",
    "keychainPassword": "mypassword",
    "remoteBuildsDir": "/Users/ben/tmp"
}, {
    projectDir: 'C:\\Users\\Ben\\Dropbox\\Yellowbox\\Yellowbox',
    projectName: 'Yellowbox',
    platformsDir: 'C:\\Users\\Ben\\Dropbox\\Yellowbox\\Yellowbox\\platforms',
    nativeProjectRoot: 'platforms\\ios'
})

buildService.build()
