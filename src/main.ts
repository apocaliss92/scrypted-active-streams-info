import sdk, { ScryptedInterface, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { ipsKey, KnownPersonResult, StreamInfo, CameraData } from "./types";
import { BasePlugin, getBaseSettings } from '../../scrypted-apocaliss-base/src/basePlugin';
import { StorageSettings } from "@scrypted/sdk/storage-settings";

const { systemManager } = sdk;

const mqttDevice = {
    ids: `scrypted-activeStream`,
    name: `Scrypted Active streams info`
}

export default class ActiveStreamsConfig extends BasePlugin implements Settings {
    lastSetMap: { [topic: string]: any } = {};
    autodiscoveryPublished = false;

    storageSettings = new StorageSettings(this, {
        ...getBaseSettings({
            onPluginSwitch: (_, enabled) => this.startStop(enabled),
        }),
        cameras: {
            type: 'device',
            title: 'Cameras',
            multiple: true,
            deviceFilter: `interfaces.includes("${ScryptedInterface.VideoCamera}")`,
            defaultValue: []
        },
        people: {
            type: 'string',
            title: 'People',
            multiple: true,
            choices: [],
            combobox: true,
            defaultValue: []
        }
    });

    constructor(nativeId: string) {
        super(nativeId, {
            pluginFriendlyName: 'Active streams info',
        });

        this.start().catch(e => this.console.log(e));
    }

    async startStop(enabled: boolean) {
        if (enabled) {
            await this.start();
        } else {
            // await this.stop(true);
        }
    }

    async getSettings(): Promise<Setting[]> {
        const { people } = this.storageSettings.values;
        const settings: Setting[] = await super.getSettings();

        people.forEach(person => {
            const personIpsKey = `${ipsKey}:${person}`;
            const currentIps = this.storageSettings.getItem(personIpsKey as any);
            this.console.log('CURRENT IPS', currentIps, typeof currentIps);
            settings.push({
                group: 'Tracked entities',
                key: personIpsKey,
                subgroup: person,
                type: 'string',
                title: `IPs`,
                multiple: true,
                value: JSON.parse(currentIps ?? '[]')
            })
        });

        return settings;
    }

    mapToStreamInfo(setting: Setting) {
        const fullIp = setting.subgroup.split(':');
        fullIp.pop();
        const ip = fullIp.join(':');
        return { camera: setting.group, ip };
    }

    private getMqttTopics({ cameraId, name }: { cameraId?: string, name?: string }) {
        let sensorTopic: string;
        let sensorInfoTopic: string;
        let autodiscoveryTopic: string;

        if (cameraId && !name) {
            sensorTopic = `scrypted/activeStreams/${cameraId}`;
            autodiscoveryTopic = `homeassistant/sensor/scrypted-active-streams-${cameraId}/ActiveStreams/config`;
        } else if (name && !cameraId) {
            sensorTopic = `scrypted/activeStreams/${name}`;
            autodiscoveryTopic = `homeassistant/sensor/scrypted-active-stream-${name}/ActiveStream/config`;
        } else if (name && cameraId) {
            sensorTopic = `scrypted/activeStreams/${cameraId}/${name}`;
            autodiscoveryTopic = `homeassistant/binary_sensor/scrypted-active-stream-${cameraId}-${name}/ActiveStream/config`;
        } else {
            sensorTopic = `scrypted/activeStreams`;
            autodiscoveryTopic = `homeassistant/sensor/scrypted-active-streams/ActiveStreams/config`;
        }

        sensorInfoTopic = `${sensorTopic}/info`;

        return {
            sensorTopic,
            sensorInfoTopic,
            autodiscoveryTopic
        }
    }

    private async processMqttData({ cameraId, name, value, info }: { cameraId?: string, name?: string, value: any, info: any }) {
        const { sensorTopic, sensorInfoTopic } = this.getMqttTopics({ cameraId, name });
        const lastValue = this.lastSetMap[sensorTopic];
        if (lastValue !== value) {
            await this.mqttClient.publish(sensorTopic, value);
            await this.mqttClient.publish(sensorInfoTopic, JSON.stringify(info));
            this.lastSetMap[sensorTopic] = value;
        }
    }

    async processCamera(cameraId: string, settings: Setting[], activeStreamsConfigs: Setting[], isWhitelisted: boolean, knownPeople: string[]) {
        const camera = systemManager.getDeviceById(cameraId);
        const cameraName = camera.name;
        const cameraStreamsInformation = settings.filter(setting => setting.group === camera.name);

        const knownPeopleResult: KnownPersonResult[] = [];

        const activeClients = Number(cameraStreamsInformation.find(setting => setting.title === 'Active Streams')?.value ?? 0);

        for (const name of knownPeople) {
            const ips = (activeStreamsConfigs.find(setting => setting.key === `activeStreamsIps:${name}`)?.value ?? []) as string[];
            const personActiveStreams: StreamInfo[] = (cameraStreamsInformation
                .filter(setting => ips.some(ip => setting.subgroup?.startsWith(ip)) && setting.key === 'type') ?? [])
                .map(this.mapToStreamInfo);

            knownPeopleResult.push({
                cameraName,
                cameraId,
                person: name,
                settings: personActiveStreams
            })

            if (isWhitelisted) {
                const isPersonActive = !!personActiveStreams.length;
                await this.processMqttData({ cameraId, name, value: isPersonActive, info: { streams: personActiveStreams } });
            }
        }

        if (isWhitelisted) {
            await this.processMqttData({ cameraId, value: activeClients, info: { streams: knownPeopleResult.flatMap(elem => elem.settings) } });
        }

        return { activeClients, knownPeopleResult, cameraName };
    }

    private async processMqttAutodiscovery(cameraData: CameraData[], whitelistedCameraIds: string[], knownPeople: string[]) {
        if (!this.autodiscoveryPublished) {
            for (const data of cameraData) {
                const { id: cameraId, name: cameraName } = data;
                if (whitelistedCameraIds.includes(cameraId)) {
                    for (const name of knownPeople) {
                        const { sensorTopic, autodiscoveryTopic, sensorInfoTopic } = this.getMqttTopics({ cameraId, name });
                        const config = {
                            state_topic: sensorTopic,
                            json_attributes_topic: sensorInfoTopic,
                            json_attributes_template: '{{ value_json | tojson }}',
                            payload_on: 'true',
                            payload_off: 'false',
                            dev: mqttDevice,
                            unique_id: `scrypted-active-stream-${cameraId}-${name}`,
                            name: `${cameraName} ${name} active`,
                        };
                        await this.mqttClient.publish(autodiscoveryTopic, JSON.stringify(config));
                    }

                    const { sensorTopic, autodiscoveryTopic, sensorInfoTopic } = this.getMqttTopics({ cameraId });
                    const config = {
                        state_topic: sensorTopic,
                        json_attributes_topic: sensorInfoTopic,
                        json_attributes_template: '{{ value_json | tojson }}',
                        dev: mqttDevice,
                        unique_id: `scrypted-active-streams-${cameraId}`,
                        name: `${cameraName} active streams`,
                    };
                    await this.mqttClient.publish(autodiscoveryTopic, JSON.stringify(config));
                }
            }

            for (const name of knownPeople) {
                const { sensorTopic, autodiscoveryTopic, sensorInfoTopic } = this.getMqttTopics({ name });
                const config = {
                    state_topic: sensorTopic,
                    json_attributes_topic: sensorInfoTopic,
                    json_attributes_template: '{{ value_json | tojson }}',
                    dev: mqttDevice,
                    unique_id: `scrypted-active-streams-${name}`,
                    name: `${name} active streams`,
                };
                await this.mqttClient.publish(autodiscoveryTopic, JSON.stringify(config));
            }

            const { sensorTopic, autodiscoveryTopic, sensorInfoTopic } = this.getMqttTopics({});
            const config = {
                state_topic: sensorTopic,
                json_attributes_topic: sensorInfoTopic,
                json_attributes_template: '{{ value_json | tojson }}',
                dev: mqttDevice,
                unique_id: `scrypted-active-streams`,
                name: `All active streams`,
            };
            await this.mqttClient.publish(autodiscoveryTopic, JSON.stringify(config));

            this.autodiscoveryPublished = true;
        }
    }

    async start() {
        this.getMqttClient();

        // const objDetectionPlugin = systemManager.getDeviceByName('Scrypted NVR Object Detection') as unknown as Settings;
        // const settings = await objDetectionPlugin.getSettings();
        // const knownPeople = settings?.find(setting => setting.key === 'knownPeople')?.choices
        //     ?.filter(choice => !!choice);
        // this.storageSettings.settings.people.choices = knownPeople;

        setInterval(async () => {
            try {

                const { cameras, people } = this.storageSettings.values;
                const activeStreamsConfigs = await this.getSettings();
                //this.console.log(`Active streams configs: ${JSON.stringify(activeStreamsConfigs, undefined, 2)}`);

                const cameraIds: string[] = [];

                Object.entries(systemManager.getSystemState()).forEach(([deviceId, device]) => {
                    if (device.interfaces.value.includes(ScryptedInterface.VideoCamera)) {
                        cameraIds.push(deviceId);
                    }
                })

                const cameraData: CameraData[] = [];
                const peopleData: { [person: string]: StreamInfo[] } = {};

                let totalActiveStreams = 0;
                const totalKnownPeopleResult: KnownPersonResult[] = [];

                const adaptivePlugin = systemManager.getDeviceByName('Adaptive Streaming') as unknown as (Settings);
                const settings = await adaptivePlugin.getSettings();

                this.console.log(`All settings: ${JSON.stringify(settings, undefined, 2)}`);

                for (const cameraId of cameraIds) {
                    const isWhitelisted = cameras.includes(cameraId);
                    const { activeClients, knownPeopleResult, cameraName } = await this.processCamera(cameraId, settings, activeStreamsConfigs, isWhitelisted, people);
                    totalActiveStreams += activeClients;
                    totalKnownPeopleResult.push(...knownPeopleResult);

                    knownPeopleResult.forEach(elem => {
                        const { person, settings } = elem;
                        if (!peopleData[person]) {
                            peopleData[person] = [];
                        }

                        peopleData[person].push(...settings);
                    });

                    cameraData.push({ name: cameraName, id: cameraId, activeStreams: activeClients });
                }

                for (const person of people) {
                    const personStreams = peopleData[person] ?? [];
                    const activeClients = personStreams.length;
                    this.processMqttData({ name: person, value: activeClients, info: { streams: personStreams } });
                }

                this.processMqttData({
                    value: totalActiveStreams, info: {
                        streams: settings
                            .filter(setting => setting.key === 'type')
                            .map(this.mapToStreamInfo)
                    }
                });

                this.processMqttAutodiscovery(cameraData, cameras, people)
            } catch (e) {
                this.console.log(e);
            }
        }, 10000);
    }
}
