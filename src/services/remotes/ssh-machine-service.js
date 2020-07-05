const { sleep } = require("../../utils");
const { exec, execSync, spawnSync } = require('child_process')

const EXEC_OPTS = {
    windowsHide: true,
    shell: 'bash'
}

/**
 * A remote service that performs builds on a remote SSH machine
 */
class SSHMachineService {
    /**
     * @param {*} $fs 
     * @param {*} $logger 
     * @param {*} $cleanupService 
     * @param {*} platform 
     * @param {*} localEnv 
     * @param {{ machines: string[], sshUser: string, shell?: string, keychainPassword: string, remoteBuildsDir: string }} options ssh remote options
     * @param {{ projectName: string, projectDir: string, platformsDir: string, nativeProjectRoot: string }} projectData
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
     * @param {{ envDependencies: any, buildLevelLocalEnvVars: any, buildLevelRemoteEnvVars: any, projectData: any, cliArgs: any, appOutputPath: any }} buildOptions
     */
    async build(buildOptions) {
        console.log(`build calling getSSHChildProcess`);
        
        this.machine = this.getFirstMachineOnline()
        
        // Skip all building if the file already exists
        if (await this.getCmdStatus(`[ -f "${this.ipaFile}" ] && echo "Y"`) !== 0) {
            console.log(`${this.ipaFile} Not found. Proceeding with build...`);
            /** @type {import("child_process").ChildProcess} newCP */
            this.sshCP = this.getSSHChildProcess()
            this.sshCP.stdio.forEach(v => v.on('data', data => console.log(data.toString().trim())))
            this.attachOutputWatchers()
            this.sshConnProm = new Promise(resolve => this.sshCP.on("close", resolve))
            
            // Setup remote directory
            console.log(`Making parent directories ${this.options.remoteBuildsDir}/${this.projectData.projectName}`);
            this.getResp(`mkdir -p ${this.options.remoteBuildsDir}/${this.projectData.projectName}`)
    
            // Send app files to recipient
            await this.rsyncToRemote()
    
            // Setup remote
            const keychainCommand = `security -v unlock-keychain -p "${this.options.keychainPassword}" login.keychain`
            this.getResp(". /etc/profile")
            this.getResp(". ~/.profile")
            this.getResp(`cd ~/tmp/${this.projectData.projectName}`)
            this.getResp(`npm i && ${keychainCommand}; tns build ios --for-device --env.sourceMap; exit`)  // The process needs to end after this
    
            const code = await this.sshConnProm
            console.log("Uploading and building finished with", { code });
        }

        console.log(`${this.ipaFile} ready. Rsyncing back to local machine`)

        // Sync the files back over from the remote
        await this.rsyncFromRemote()
    }

    async rsyncToRemote() {
        const remoteDir = `${this.options.sshUser}@${this.machine}:/Users/${this.options.sshUser}/tmp/${this.projectData.projectName}`
        console.log(`Sending app files to remote dir ${remoteDir}`)
        const cp = exec(`rsync -avz --exclude={node_modules,platforms,hooks,.git,nodemon.json,.DS_Store} ./ ${remoteDir}`, EXEC_OPTS)
        cp.stdout.pipe(process.stdout)
        cp.stderr.pipe(process.stderr)
        await new Promise(resolve => cp.on('close', resolve))
    }

    async rsyncFromRemote() {
        const remoteDir = `${this.options.sshUser}@${this.machine}:/Users/${this.options.sshUser}/tmp/${this.projectData.projectName}`
        console.log(`Retrieving built files ${remoteDir}/platforms/ios --> ./platforms`)
        const cp = exec(`rsync -avz --delete ${remoteDir}/platforms/ios ./platforms`, EXEC_OPTS)
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
                this.sshCP.stdout.on('data', function (d) {
                    resolve(d)
                    if (this.sshCP)
                        this.sshCP.stdout.off('data', this)
                })
                this.sshCP.stderr.on('data', function (d) {
                    reject(d)
                    if (this.sshCP)
                        this.sshCP.stderr.off('data', this)
                })
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