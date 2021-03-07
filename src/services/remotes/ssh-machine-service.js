const { sleep } = require("../../utils");
const { spawn, exec, spawnSync } = require('child_process')
const path = require('path')

// Setup ssh connection
const { NodeSSH } = require('node-ssh');
const { existsSync } = require("fs");

const EXEC_OPTS = {
    windowsHide: true,
    shell: 'bash'
}

/**
 * A remote service that performs builds on a remote machine over SSH
 */
class SSHMachineService {
    /**
     * Update references.d.ts to point to your own cloned copy of [nativescript-cli](https://github.com/NativeScript/nativescript-cli) to get correct parameter typings
     * @param {import('../../../../../../nativescript-cli/lib/common/declarations').IFileSystem} $fs
     * @param {ILogger} $logger
     * @param {import("../../../../../../nativescript-cli/lib/definitions/project").IProjectCleanupService} $cleanupService
     * @param {"android" | "ios"} platform
     * @param {object} localEnv
     * @param {{ machines: string[], sshUser: string, shell?: string, keychainPassword: string, remoteBuildsDir: string }} options ssh remote options
     * @param {import("../../../../../../nativescript-cli/lib/definitions/project").IProjectData & { nativeProjectRoot: string }} projectData
     */
    constructor($fs, $logger, $cleanupService, platform, localEnv, options, projectData) {
        console.log(`Constructing new SSHMachineService`);
        this.$fs = $fs;
        this.$logger = $logger;
        this.platform = platform;
        this.$cleanupService = $cleanupService;

        this.options = options
        /** Hostname of the remote machine @type {string} */
        this.machine = undefined
        /** Resolves when the remote disconnects @type {Promise<any>} */
        this.sshConnProm = undefined
        this.projectData = projectData
        this.projectDirRemote = path.posix.join(this.options.remoteBuildsDir, this.projectData.projectName)
        this.ssh = new NodeSSH()
    }

    /**
     * Attach process output watchers to listen for errors and disconnect from the remote if necessary
     */
    attachOutputWatchers() {
        if (!this.sshCP) return
        const checker = data => {
            if (/No project found/.test(data)) {
                this.disconnect(data)
                console.error(`Project not found on remote. Disconnecting...`)
            } else if (/user name or passphrase you entered is not correct/i.test(data)) {
                this.disconnect(data)
                console.error(`Incorrect keychain password. Update ${this.projectData.projectDir}/.nsremote.config.json and run again`)
            }
        }
        this.sshCP.stdout.on('data', checker)
        this.sshCP.stderr.on('data', checker)
    }

    /**
     * Run an arbitrary command using a node subprocess, over an ssh pipe
     * @param {string} command Command to be run on the remote machine
     * @returns {number} The exit code from the command run
     * @throws {Error} Error if the process ends with a non-0 exit code, with the last stdout or stderr output from the process
     */
    sshRunCommand(command) {
        const child = spawn('ssh', [
            `${this.options.sshUser}@${this.machine} -t 'bash -ci ". /etc/profile; ${command}"'`
        ], {
            stdio: [  // Use parents stdin, stdout and stderr (^c should get forwarded to ssh &/or to the remote?)
                0,
                process.stdout,
                process.stderr
            ]
        })

        return new Promise((resolve, reject) => {
            child.on('exit', (code, signal) => {
                if (code === 0)
                    resolve()
                else
                    reject(new Error(`Child process for ssh command ${command} returned non-0 exit code (${code}), signal ${signal}`))
            })
        })
    }

    disconnect(err) {
        this.sshCP.stdin.write('exit\n')
        throw new Error(err)
    }

    /**
     * Path on remote of the final ipa file produced by the build process
     */
    get ipaFile() {
        return `${this.options.remoteBuildsDir}/${this.projectData.projectName}/platforms/ios/build/Debug-iphoneos/${this.projectData.projectName}.ipa`
    }

    /**
     * Run the passed command on the remote machine, first setting up the shell and switching
     * directory to the project directory
     * @param {string} command
     */
    async runCommand(command) {
        console.log(command);
        // return ssh.execCommand(`. /etc/profile; . ~/.profile; . ~/.bashrc; cd ${projectDirRemote}; ${command}`)
        const result = await this.ssh.execCommand(`. /etc/profile; $SHELL -ci '${command}'`, {
            cwd: this.projectDirRemote,
            onStderr: chunk => console.error(chunk.toString().trim()),  // Ensures no duplicate newline written
            // onStderr: chunk => process.stderr.write(chunk, 'buffer'),  // Ensures no duplicate newline written
            // buf => console.warn(`${this.options.sshUser}@${this.machine} [STDERR]: ${buf}`),
            onStdout: chunk => console.log(chunk.toString().trim())
            // onStdout: chunk => process.stdout.write(chunk, 'buffer')
            // buf => console.log(`${this.options.sshUser}@${this.machine} [STDOUT]: ${buf}`)
        })
        if (result.code !== null)
            throw new Error(`Command ${command} exited with code ${result.code}`)
        return result
    }

    /**
     * @param {{ cliArgs: { clean: boolean } }} buildOptions
     */
    async build(buildOptions) {
        console.log(`Checking if local ipa exists at "${this.projectData.nativeProjectRoot}/build/Debug-iphoneos/${this.projectData.projectName}.ipa" and no clean build flag`);
        const localIPAFile = path.resolve(this.projectData.nativeProjectRoot, 'build', 'Debug-iphoneos', `${this.projectData.projectName}.ipa`)
        if (this.$fs.exists(localIPAFile)) {
            if (buildOptions.cliArgs.clean) {
                console.log(`--clean flag specified. Deleting ${localIPAFile}`);
                this.$fs.deleteFile(localIPAFile)
            } else {
                return console.log(`.ipa already exists locally, run with --clean to force rebuild on remote and re-sync`)
            }
        }

        for (const machine of this.options.machines) {
            console.log(`Trying ssh connection to ${machine}...`);
            try {
                await this.ssh.connect({
                    host: machine,
                    username: this.options.sshUser,
                    password: this.options.keychainPassword,
                    // TODO: specify identity file in .nsremote file
                    readyTimeout: 1000,
                })
                this.machine = machine
                break
            } catch (error) {
                this.ssh.dispose()  // Without disposing, this.ssh.isConnected() will return true
                console.warn(error.message || error);
            }
        }

        if (!this.ssh.isConnected())
            throw new Error(`SSHMachineService unable to connect to any of the specified machines ${this.options.machines}`)

        console.log(`SSH session started using ${this.options.sshUser}@${this.machine}`);
        
        const remotePlatformsiOSDir = path.posix.join(this.projectDirRemote, 'platforms', 'ios')
        const findIPAsCommand = `find ${remotePlatformsiOSDir} -name "*.ipa"`
        let ipas = [];

        if (buildOptions.cliArgs.clean) {
            const eraseCmd = `npx rimraf ${this.projectDirRemote}`
            // rimraf will sometimes give a "system cannot find the path specified" or similar error
            // even though it successfully removes the directory
            await this.runCommand(eraseCmd).catch(err => {
                console.warn(`Error while running ${eraseCmd}: ${err.message || err}`);
            })
        } else {
            // If a valid ipa is already sitting on the remote
            try {
                ipas = (await this.runCommand(findIPAsCommand)).stdout.split('\n')
            } catch (error) {
                console.log(`${findIPAsCommand} ${error.message || error}: Assuming error relating to remote path not existing`);
            }
        }

        if (!ipas.length) {
            console.log(`Copy project files to remote...`);
            const ignoreRE = /node_modules|\.git$|^platforms|^hooks|plugins.*?demo$|plugins.*?demo-vue$|plugins.*?demo-ng$|plugins.*?ng-demo$|plugins.*?demo-push$/
            await this.ssh.putDirectory(this.projectData.projectDir, this.projectDirRemote, {
                recursive: true,
                concurrency: 10,
                // ^ WARNING: Not all servers support high concurrency
                // try a bunch of values and see what works on your server
                validate: itemPath => {
                    const relPath = path.relative(this.projectData.projectDir, itemPath)
                    return !ignoreRE.test(relPath)
                },
                tick: (localPath, remotePath, error) => {
                    if (error) {
                        console.warn(`Failed to copy ${localPath} to ${remotePath}`)
                    } else {
                        console.log(`Created ${remotePath}`);
                    }
                }
            })
            
            const keychainCommand = `security -v unlock-keychain -p "${this.options.keychainPassword}" login.keychain`
            if (existsSync(path.resolve(this.projectData.projectDir, 'yarn.lock'))) {
                await this.runCommand('yarn install')
            }

            await this.runCommand(keychainCommand)
            await this.runCommand('tns build ios --for-device --env.sourceMap')
            
            ipas = (await this.runCommand(findIPAsCommand)).stdout.split('\n')
        }
        
        for (const ipaFile of ipas) {
            const ipaRelPath = path.relative(this.projectDirRemote, ipaFile)
            const copyToPath = path.resolve(this.projectData.projectDir, ipaRelPath)
            // Create folders including parent heirarchy for copying back the ipa
            console.log(`Create directory ${path.dirname(copyToPath)} for copy from ${ipaFile}`);
            this.$fs.createDirectory(path.dirname(copyToPath))
            await this.ssh.getFile(path.resolve(this.projectData.projectDir, ipaRelPath), ipaFile)
            // TODO: Touch the ipa file and all parent directories so their last modified time is
            // newer than all those checked by containsNewerFiles:
            // https://github.com/NativeScript/nativescript-cli/blob/f3e5ed97b4f55b15771e3f04c0c6e7f06d0ad41d/lib/services/project-changes-service.ts#L360
            // otherwise next time we run the app the cli is going to think it needs another rebuild
            // and we will run the whole ssh machine service again
            console.log(`Successfully retrieved ${path.basename(ipaFile)} -> ${ipaRelPath}`);
        }

        // Copy .nsbuildinfo back from remote for the cli
        try {
            const remoteFile = path.posix.resolve(remotePlatformsiOSDir, 'build', 'Debug-iphoneos', '.nsbuildinfo')
            const localFile = path.resolve(this.projectData.projectDir, 'platforms', 'ios', 'build', 'Debug-iphoneos', '.nsbuildinfo')
            console.log(`Get .nsbuildinfo ${remoteFile} -> ${localFile}`);
            await this.ssh.getFile(localFile, remoteFile)
        } catch (error) {
            console.warn(`Ignoring error retrieving .nsparepareinfo: ${error}`);
        }

        console.log(`SSHMachineService build and retrieval complete using ${this.options.sshUser}@${this.machine}`);
        this.ssh.dispose()
        return 
    }

    async rsyncToRemote() {
        const remoteDir = `${this.options.sshUser}@${this.machine}:${this.projectDirRemote}/${this.projectData.projectName}`
        console.log(`Sending app files to remote dir ${remoteDir}`)
        // NOTE: For rsync / refers to ./ i.e. the transfer source directory
        const cp = exec(`rsync -avzp --delete --exclude={node_modules,/platforms,*/demo/*,*/demo-vue/*,*/demo-ng/*,*/ng-demo/*,*/demo-push/*,/hooks,.git,.DS_Store} ./ ${remoteDir}`, EXEC_OPTS)
        cp.stdout.pipe(process.stdout)
        cp.stderr.pipe(process.stderr)
        await new Promise(resolve => cp.on('close', resolve))
    }

    async rsyncFromRemote() {
        const remoteDir = `${this.options.sshUser}@${this.machine}:${this.projectDirRemote}/${this.projectData.projectName}`
        console.log(`Retrieving built files ${remoteDir}/platforms/ios --> ./platforms`)
        // The following locations have file modification times compared against .nsprepareinfo. If any files in these locations
        // have changes, this will trigger a build
        // containsNewerFiles will check C:\Users\Ben\Dropbox\Yellowbox\Yellowbox\app\App_Resources\iOS
        // containsNewerFiles will check C:\Users\Ben\Dropbox\Yellowbox\Yellowbox\app\App_Resources\iOS\Assets.xcassets
        // containsNewerFiles will check C:\Users\Ben\Dropbox\Yellowbox\Yellowbox\app\App_Resources\iOS\Assets.xcassets\AppIcon.appiconset
        // containsNewerFiles will check C:\Users\Ben\Dropbox\Yellowbox\Yellowbox\app\App_Resources\iOS\Assets.xcassets\LaunchImage.launchimage
        // containsNewerFiles will check C:\Users\Ben\Dropbox\Yellowbox\Yellowbox\app\App_Resources\iOS\Assets.xcassets\LaunchScreen.AspectFill.imageset
        // containsNewerFiles will check C:\Users\Ben\Dropbox\Yellowbox\Yellowbox\app\App_Resources\iOS\Assets.xcassets\LaunchScreen.Center.imageset
        // containsNewerFiles will check C:\Users\Ben\Dropbox\Yellowbox\Yellowbox\app\App_Resources\iOS\navigation
        // containsNewerFiles will check C:\Users\Ben\Dropbox\Yellowbox\Yellowbox\node_modules\nativescript-app-sync\platforms\ios
        // containsNewerFiles returns true for C:\Users\Ben\Dropbox\Yellowbox\Yellowbox\node_modules\nativescript-app-sync\platforms\ios as the dir itself has been modified.
        
        // Add -t to preserve modification times, although this means you need to make sure
        // .nsprepareinfo (.nsbuildinfo after NS 7?) from the remote is newer than all the other
        // files above (for example, deleting node_modules and reinstalling on this master machine
        // will mean you also need to run the whole build again on the remote to change the
        // modification time of .nsprepareinfo) Add -z (compress) flag if using over WAN or lower
        // bandwidth LAN connection

        // rsync ONLY the required .ipa for running the app AND create the directory structure https://stackoverflow.com/a/22908437
        // -t is INTENTIONALLY omitted, so that after syncing back the .ipa, changes don't cause a complete rebuild every time (the watchers monitor the change times of the folders themselves above^)
        const cp = exec(`rsync -rlpgoD -u --progress --relative ${remoteDir}/./platforms/ios/build/**/*.ipa ./`, EXEC_OPTS)
        cp.stdout.pipe(process.stdout)
        cp.stderr.pipe(process.stderr)
        await new Promise(resolve => cp.on('close', code => {
            if (code !== 0)
                console.warn(`WARNING: rsync did not exit cleanly! Not all files may have been copied back from the remote`)
            resolve(code)
        }))
    }


    /**
     * Run a command on the remote and get the output synchronously
     * @param {string} command 
     */
    getCmdStatus(command) {
        console.log(`getCmdStatus running ${command}`);
        return new Promise(resolve => exec(`ssh ${this.options.sshUser}@${this.machine} '. /etc/profile; . ~/.profile; ${command}'`, EXEC_OPTS).on("close", resolve))
    }

    /**
     * Run a command on the remote machine and return the output
     * WARNING: Do not use this to do long running comands. They need to
     * be tied together with && or ; as a single command
     * @param {string} command Command to run on remote machine
     */
    async getResp(command) {
        try {
            const prom = new Promise((resolve, reject) => {
                const onStdOut = (d) => {
                    resolve(d)
                    if (this.sshCP)
                        this.sshCP.stdout.off('data', onStdOut)
                }
                this.sshCP.stdout.on('data', onStdOut)
                const onErr = (d) => {
                    reject(d)
                    if (this.sshCP)
                        this.sshCP.stderr.off('data', onErr)
                }
                this.sshCP.stderr.on('data', onErr)
            })
            this.sshCP.stdin.write(command + "\n")
            const result = await prom
            await sleep(50)  // More output coming?
            return result
        } catch (error) {
            console.error(`Error sending command ${command}`, error)
        }
    }

    /**
     * Pings each machine and assigns this.machine based on which responds first
     */
    getFirstMachineOnline() {
        for (const m of this.options.machines) {
            console.log(`Pinging ${m}...`);
            // Attempt 1 ping with a 4 second timeout, use status to determine if machine available
            if (spawnSync('ping', [m, '-w', '4', '-n', '1'], { stdio: 'pipe' }).status === 0) {
                return m
            }
        }
        throw new Error(`No machines responded to ping (machines = ${JSON.stringify(this.options.machines)})`)
    }

    /**
     * Get a child process which is running an SSH session with an active machine
     * @returns {import("child_process").ChildProcess}
     */
    getSSHChildProcess() {
        console.log(`Attempting SSH login ${this.options.sshUser}@${this.machine}...`);
        return exec(`ssh ${this.options.sshUser}@${this.machine}`, EXEC_OPTS)
    }
}

module.exports.SSHMachineService = SSHMachineService;