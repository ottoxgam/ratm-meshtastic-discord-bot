import crypto from "crypto";
import path from "path";
import mqtt from "mqtt";
import protobufjs from "protobufjs";
import fs from "fs";
import axios from "axios";
import { fileURLToPath } from "url";
import { dirname } from "path";
import FifoKeyCache from "./src/FifoKeyCache";
import MeshPacketQueue, { PacketGroup } from "./src/MeshPacketQueue";
import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { createClient } from "redis";
import { env } from "process";

// generate a pseduo uuid kinda thing to use as an instance id
const INSTANCE_ID = (() => {
  return crypto.randomBytes(4).toString("hex");
})();

function loggerDateString() {
  return process.env.ENVIRONMENT === "production"
    ? ""
    : new Date().toISOString() + " ";
}

const logger = {
  info: (message: string) => {
    console.log(`${loggerDateString()}[${INSTANCE_ID}] [INFO] ${message}`);
  },
  error: (message: string) => {
    console.log(`${loggerDateString()}[${INSTANCE_ID}] [ERROR] ${message}`);
  },
  debug: (message: string) => {
    console.log(`${loggerDateString()}[${INSTANCE_ID}] [DEBUG] ${message}`);
  },
};

Sentry.init({
  environment: process.env.ENVIRONMENT || "development",
  integrations: [nodeProfilingIntegration()],
  // Performance Monitoring
  tracesSampleRate: 1.0, //  Capture 100% of the transactions

  // Set sampling rate for profiling - this is relative to tracesSampleRate
  profilesSampleRate: 1.0,
});

Sentry.setTag("instance_id", INSTANCE_ID);

logger.info(`Starting Rage Against Mesh(ine) ${INSTANCE_ID}`);

let pfpDb = { default: "https://cdn.discordapp.com/embed/avatars/0.png" };

if (process.env.PFP_JSON_URL) {
  logger.info(`Using PFP_JSON_URL=${process.env.PFP_JSON_URL}`);
  axios.get(process.env.PFP_JSON_URL).then((response) => {
    pfpDb = response.data;
    logger.info(`Loaded ${Object.keys(pfpDb).length} pfp entries`);
  });
}

let ignoreDB = JSON.parse(fs.readFileSync("./ignoreDB.json").toString());
if (process.env.RBL_JSON_URL) {
  logger.info(`Using RBL_JSON_URL=${process.env.RBL_JSON_URL}`);
  axios.get(process.env.RBL_JSON_URL).then((response) => {
    ignoreDB = response.data;
    logger.info(`Loaded ${ignoreDB.length} rbl entries`);
  });
}

const mqttBrokerUrl = "mqtt://mqtt.meshtastic.org"; // the original project took a nose dive, so this server is trash
const KK6VSYMqttBrokerUrl = "mqtt://192.168.10.14";
const mqttUsername = "meshdev";
const mqttPassword = "large4cats";

const redisClient = createClient({
  url: process.env.REDIS_URL,
});

(async () => {
  if (process.env.REDIS_ENABLED === "true") {
    // Connect to redis server
    await redisClient.connect();
    logger.info(`Setting active instance id to ${INSTANCE_ID}`);
    redisClient.set(`socalmesh:active`, INSTANCE_ID);
  }
})();

const decryptionKeys = [
  "1PG7OiApB1nwvP+rz05pAQ==", // add default "AQ==" decryption key
];

const nodeDB = JSON.parse(fs.readFileSync("./nodeDB.json").toString());
const cache = new FifoKeyCache();
const meshPacketQueue = new MeshPacketQueue();

const updateNodeDB = (
  node: string,
  longName: string,
  nodeInfo: any,
  hopStart: number,
) => {
  try {
    nodeDB[node] = longName;
    if (process.env.REDIS_ENABLED === "true") {
      redisClient.set(`socalmesh:node:${node}`, longName);
      const nodeInfoGenericObj = JSON.parse(JSON.stringify(nodeInfo));
      // remove leading "!" from id
      nodeInfoGenericObj.id = nodeInfoGenericObj.id.replace("!", "");
      // add hopStart to nodeInfo
      nodeInfoGenericObj.hopStart = hopStart;
      nodeInfoGenericObj.updatedAt = new Date().getTime();
      redisClient.json
        .set(`socalmesh:nodeinfo:${node}`, "$", nodeInfoGenericObj)
        .then(() => {
          // redisClient.json
          //   .get(`socalmesh:nodeinfo:${node}`) // , { path: "$.hwModel" }
          //   .then((data) => {
          //     if (data) {
          //       logger.info(JSON.stringify(data));
          //     }
          //   });
        })
        .catch((err) => {
          // console.log(nodeInfoGenericObj);
          // if (err === "Error: Existing key has wrong Redis type") {
          redisClient.type(`socalmesh:nodeinfo:${node}`).then((result) => {
            logger.info(result);
            if (result === "string") {
              redisClient.del(`socalmesh:nodeinfo:${node}`).then(() => {
                redisClient.json
                  .set(`socalmesh:nodeinfo:${node}`, "$", nodeInfoGenericObj)
                  .then(() => {
                    logger.info("deleted and re-added node info for: " + node);
                  })
                  .catch((err) => {
                    logger.error(err);
                  });
              });
            }
          });
          // }
          logger.error(`redis key: socalmesh:nodeinfo:${node} ${err}`);
        });
    }
    fs.writeFileSync(
      path.join(__dirname, "./nodeDB.json"),
      JSON.stringify(nodeDB, null, 2),
    );
  } catch (err) {
    // logger.error(err.message);
    Sentry.captureException(err);
  }
};

const isInIgnoreDB = (node: string) => {
  return ignoreDB.includes(node);
};

const getNodeInfos = async (nodeIds: string[], debug: boolean) => {
  try {
    // const foo = nodeIds.slice(0, nodeIds.length - 1);
    nodeIds = Array.from(new Set(nodeIds));
    const nodeInfos = await redisClient.json.mGet(
      nodeIds.map((nodeId) => `socalmesh:nodeinfo:${nodeId2hex(nodeId)}`),
      "$",
    );
    if (debug) {
      logger.debug(JSON.stringify(nodeInfos));
    }

    const formattedNodeInfos = nodeInfos.flat().reduce((acc, item) => {
      if (item && item.id) {
        acc[item.id] = item;
      }
      return acc;
    }, {});

    // const formattedNodeInfos = nodeInfos.reduce((acc, [info]) => {
    //   if (info && info.id) {
    //     acc[info.id] = info;
    //   }
    //   return acc;
    // }, {});
    if (Object.keys(formattedNodeInfos).length !== nodeIds.length) {
      // figure out which nodes are missing from nodeInfo and print them
      // console.log(
      //   "ABC",
      //   nodeInfos[0].map((nodeInfo) => nodeInfo.id),
      // );
      // console.log(Object.keys(formattedNodeInfos).length, nodeIds.length);
      const missingNodes = nodeIds.filter((nodeId) => {
        return formattedNodeInfos[nodeId] === undefined;
      });
      logger.info("Missing nodeInfo for nodes: " + missingNodes.join(","));
    }
    // console.log("Feep", nodeInfos);
    return formattedNodeInfos;
  } catch (err) {
    // logger.error(err.message);
    Sentry.captureException(err);
  }
  return {};
};

const getNodeName = (nodeId: string | number) => {
  // redisClient.json.get(`socalmesh:nodeinfo:${nodeId}`).then((nodeInfo) => {
  //   if (nodeInfo) {
  //     logger.info(nodeInfo);
  //   }
  // });
  return nodeDB[nodeId2hex(nodeId)] || "Unknown";
};

const nodeId2hex = (nodeId: string | number) => {
  return typeof nodeId === "number"
    ? nodeId.toString(16).padStart(8, "0")
    : nodeId;
};

const nodeHex2id = (nodeHex: string) => {
  return parseInt(nodeHex, 16);
};

const prettyNodeName = (nodeId: string | number) => {
  const nodeIdHex = nodeId2hex(nodeId);
  const nodeName = getNodeName(nodeId);
  return nodeName ? `${nodeIdHex} - ${nodeName}` : nodeIdHex;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// load protobufs
const root = new protobufjs.Root();
root.resolvePath = (origin, target) =>
  path.join(__dirname, "src/protobufs", target);
root.loadSync("meshtastic/mqtt.proto");
const Data = root.lookupType("Data");
const ServiceEnvelope = root.lookupType("ServiceEnvelope");
const User = root.lookupType("User");
const Position = root.lookupType("Position");

if (!process.env.DISCORD_WEBHOOK_URL) {
  logger.error("DISCORD_WEBHOOK_URL not set");
  process.exit(-1);
}

const LFwebhookUrl = process.env.DISCORD_WEBHOOK_URL;
const MsWebhookUrl = process.env.DISCORD_MS_WEBOOK_URL;
const svLFWebhookUrl = process.env.SV_DISCORD_WEBHOOK_URL;

const mesh_topic = process.env.MQTT_TOPIC || "msh/US/CA/socalmesh";
const grouping_duration = parseInt(process.env.GROUPING_DURATION || "10000");

function sendDiscordMessage(LFwebhookUrl: string, payload: any) {
  const data = typeof payload === "string" ? { content: payload } : payload;

  return axios
    .post(LFwebhookUrl, data)
    .then(() => {
      // console.log("Message sent successfully");
    })
    .catch((error) => {
      logger.error(
        `[error] Could not send discord message: ${error.response.status}`,
      );
    });
}

function processTextMessage(packetGroup: PacketGroup) {
  const packet = packetGroup.serviceEnvelopes[0].packet;
  const text = packet.decoded.payload.toString();
  logger.debug("createDiscordMessage: " + text);
  createDiscordMessage(packetGroup, text);
}

const createDiscordMessage = async (packetGroup, text) => {
  try {
    const packet = packetGroup.serviceEnvelopes[0].packet;
    const to = nodeId2hex(packet.to);
    const from = nodeId2hex(packet.from);
    const nodeIdHex = nodeId2hex(from);

    // discard text messages in the form of "seq 6034" "seq 6025"
    if (text.match(/^seq \d+$/)) {
      return;
    }

    if (isInIgnoreDB(from)) {
      logger.info(
        `MessageId: ${packetGroup.id} Ignoring message from ${prettyNodeName(
          from,
        )} to ${prettyNodeName(to)} : ${text}`,
      );
      return;
    }

    // ignore packets older than 5 minutes
    if (new Date(packet.rxTime * 1000) < new Date(Date.now() - 5 * 60 * 1000)) {
      logger.info(
        `MessageId: ${packetGroup.id} Ignoring old message from ${prettyNodeName(
          from,
        )} to ${prettyNodeName(to)} : ${text}`,
      );
    }

    if (process.env.ENVIRONMENT === "production" && to !== "ffffffff") {
      logger.info(
        `MessageId: ${packetGroup.id} Not to public channel: ${packetGroup.serviceEnvelopes.map((envelope) => envelope.topic)}`,
      );
      return;
    }

    if (
      packetGroup.serviceEnvelopes.filter((envelope) =>
        home_topics.some((home_topic) => envelope.topic.startsWith(home_topic)),
      ).length === 0
    ) {
      logger.info(
        `MessageId: ${packetGroup.id} No packets found in topic: ${packetGroup.serviceEnvelopes.map((envelope) => envelope.topic)}`,
      );
      return;
    }

    let nodeInfos = await getNodeInfos(
      packetGroup.serviceEnvelopes
        .map((se) => se.gatewayId.replace("!", ""))
        .concat(from),
      false,
    );

    let avatarUrl = pfpDb["default"];
    if (Object.hasOwn(pfpDb, nodeIdHex)) {
      avatarUrl = pfpDb[nodeIdHex];
    }

    const maxHopStart = packetGroup.serviceEnvelopes.reduce((acc, se) => {
      const hopStart = se.packet.hopStart;
      return hopStart > acc ? hopStart : acc;
    }, 0);

    // console.log("maxHopStart", maxHopStart);

    const content = {
      username: "Captain Hook",
      avatar_url:
        "https://cdn.discordapp.com/avatars/1355684023615361146/af64924d6f2c32bacb64d1658739af3b.png",
      embeds: [
        {
          url: `https://meshview.kk6vsy.com/packet_list/${packet.from}`,
          color: 6810260,
          timestamp: new Date(packet.rxTime * 1000).toISOString(),

          author: {
            name: `${nodeInfos[nodeIdHex] ? nodeInfos[nodeIdHex].longName : "Unknown"}`,
            url: `https://meshview.kk6vsy.com/packet_list/${packet.from}`,
            icon_url: avatarUrl,
          },
          title: `${nodeInfos[nodeIdHex] ? nodeInfos[nodeIdHex].shortName : "UNK"}`,
          description: text,
          fields: [
            // {
            //   name: `${nodeInfos[nodeIdHex] ? nodeInfos[nodeIdHex].shortName : "UNK"}`,
            //   value: text,
            // },
            // {
            //   name: "Node ID",
            //   value: `${nodeIdHex}`,
            //   inline: true,
            // },
            {
              name: "Packet",
              value: `[${packetGroup.id.toString(16)}](https://meshview.kk6vsy.com/packet/${packetGroup.id})`,
              inline: true,
            },
            {
              name: "Channel",
              value: `${packetGroup.serviceEnvelopes[0].channelId}`,
              inline: true,
            },
            ...packetGroup.serviceEnvelopes
              .filter(
                (value, index, self) =>
                  self.findIndex((t) => t.gatewayId === value.gatewayId) ===
                  index,
              )
              .map((envelope) => {
                const gatewayDelay =
                  envelope.mqttTime.getTime() - packetGroup.time.getTime();

                if (
                  envelope.gatewayId === "!75f1804c" ||
                  envelope.gatewayId === "!3b46b95c"
                ) {
                  // console.log(envelope);
                }

                let gatewayDisplaName = envelope.gatewayId.replace("!", "");
                if (nodeInfos[envelope.gatewayId.replace("!", "")]) {
                  gatewayDisplaName =
                    // nodeInfos[envelope.gatewayId.replace("!", "")].shortName +
                    // " - " +
                    nodeInfos[envelope.gatewayId.replace("!", "")].shortName; //+
                  // " " +
                  // envelope.gatewayId.replace("!", "");
                }

                let hopText = `${envelope.packet.hopStart - envelope.packet.hopLimit}/${envelope.packet.hopStart} hops`;

                if (
                  envelope.packet.hopStart === 0 &&
                  envelope.packet.hopLimit === 0
                ) {
                  hopText = `${envelope.packet.rxSnr} / ${envelope.packet.rxRssi} dBm`;
                } else if (
                  envelope.packet.hopStart - envelope.packet.hopLimit ===
                  0
                ) {
                  hopText = `${envelope.packet.rxSnr} / ${envelope.packet.rxRssi} dBm ${envelope.packet.hopStart - envelope.packet.hopLimit}/${envelope.packet.hopStart} hops`;
                }

                if (envelope.gatewayId.replace("!", "") === nodeIdHex) {
                  hopText = `Self Gated ${envelope.packet.hopStart} hopper`;
                }

                if (maxHopStart !== envelope.packet.hopStart) {
                  hopText = `:older_man: ${envelope.packet.hopStart - envelope.packet.hopLimit}/${envelope.packet.hopStart} hops`;
                }

                if (envelope.mqttServer === "public") {
                  hopText = `:poop: ${envelope.packet.hopStart - envelope.packet.hopLimit}/${envelope.packet.hopStart} hops`;
                }

                return {
                  name: `Gateway`,
                  value: `[${gatewayDisplaName} (${hopText})](https://meshview.kk6vsy.com/packet_list/${nodeHex2id(envelope.gatewayId.replace("!", ""))})${gatewayDelay > 0 ? " (" + gatewayDelay + "ms)" : ""}`,
                  inline: true,
                };
              }),
          ],
        },
      ],
    };

    //console.log(packetGroup, packetGroup.serviceEnvelopes);

    logger.info(
      `MessageId: ${packetGroup.id} Received message from ${prettyNodeName(from)} to ${prettyNodeName(to)} : ${text}`,
    );

    if (
      packetGroup.serviceEnvelopes.filter((envelope) =>
        socal_mesh_home_topics
    .some((home_topic) =>
          envelope.topic.startsWith(home_topic),
        ),
      ).length > 0
    ) {
      if (
        MsWebhookUrl &&
        packetGroup.serviceEnvelopes[0].channelId === "MediumSlow"
      ) {
        sendDiscordMessage(MsWebhookUrl, content);
      } else {
        sendDiscordMessage(LFwebhookUrl, content);
      }
    }


    if (
      packetGroup.serviceEnvelopes.filter((envelope) =>
        private_mesh_topics.some((home_topic) =>
          envelope.topic.startsWith(home_topic),
        ),
      ).length > 0
    ) {
      if (svLFWebhookUrl) {
        sendDiscordMessage(svLFWebhookUrl, content);
      }
    }
  } catch (err) {
    logger.error("Error: " + String(err));
    Sentry.captureException(err);
  }
};

// const client = mqtt.connect(mqttBrokerUrl, {
//   username: mqttUsername,
//   password: mqttPassword,
// });

const socalmesh_client = mqtt.connect(KK6VSYMqttBrokerUrl, {
  username: mqttUsername,
  password: mqttPassword,
});

const socal_mesh_home_topics = [
  "msh/US/CA/socalmesh",
  "msh/US/CA/SoCalMesh",
];

const private_mesh_topics = [
  "msh/US/CA/SacValley",
];

// home_topics is both ba and sv
const home_topics = socal_mesh_home_topics.concat(private_mesh_topics);

const nodes_to_log_all_positions = [
  "43b6ff0c", // me
  "433ea8d0", // mobile
];

const subbed_topics = ["msh/US"];

// run every 5 seconds and pop off from the queue
const processing_timer = setInterval(() => {
  if (process.env.REDIS_ENABLED === "true") {
    redisClient.get(`socalmesh:active`).then((active_instance) => {
      if (active_instance && active_instance !== INSTANCE_ID) {
        logger.error(
          `Stopping RATM instance; active_instance: ${active_instance} this instance: ${INSTANCE_ID}`,
        );
        clearInterval(processing_timer); // do we want to kill it so fast? what about things in the queue?
        // subbed_topics.forEach((topic) => client.unsubscribe(topic));
        subbed_topics.forEach((topic) => socalmesh_client
      .unsubscribe(topic));
      }
    });
  }
  const packetGroups = meshPacketQueue.popPacketGroupsOlderThan(
    Date.now() - grouping_duration,
  );
  packetGroups.forEach((packetGroup) => {
    processPacketGroup(packetGroup);
  });
}, 5000);

function sub(the_client: mqtt.MqttClient, topic: string) {
  the_client.subscribe(`${topic}/#`, (err) => {
    if (!err) {
      logger.info(`Subscribed to ${topic}/#`);
    } else {
      logger.error(`Subscription error: ${err.message}`);
    }
  });
}

// subscribe to everything when connected
socalmesh_client.on("connect", () => {
  logger.info(`Connected to Private MQTT broker`);
  subbed_topics.forEach((topic) => sub(socalmesh_client
  , topic));
});

// handle message received
socalmesh_client.on("message", async (topic: string, message: any) => {
  try {
    if (topic.includes("msh")) {
      if (!topic.includes("/json")) {
        if (topic.includes("/stat/")) {
          return;
        }
        // decode service envelope
        let envelope;
        try {
          envelope = ServiceEnvelope.decode(message);
        } catch (envDecodeErr) {
          if (
            String(envDecodeErr).indexOf("invalid wire type 7 at offset 1") ===
            -1
          ) {
            logger.error(
              `MessageId: Error decoding service envelope: ${envDecodeErr}`,
            );
          }
          return;
        }
        if (!envelope || !envelope.packet) {
          return;
        }

        if (
          home_topics.some((home_topic) => topic.startsWith(home_topic)) ||
          nodes_to_log_all_positions.includes(
            nodeId2hex(envelope.packet.from),
          ) ||
          meshPacketQueue.exists(envelope.packet.id)
        ) {
          // return;
        } else {
          // logger.info("Message received on topic: " + topic);
          return;
        }

        // attempt to decrypt encrypted packets
        const isEncrypted = envelope.packet.encrypted?.length > 0;
        if (isEncrypted) {
          const decoded = decrypt(envelope.packet);
          if (decoded) {
            envelope.packet.decoded = decoded;
          }
        }

        if (cache.exists(shaHash(envelope))) {
          // logger.debug(
          //   `FifoCache: Already received envelope with hash ${shaHash(envelope)} MessageId: ${envelope.packet.id}  Gateway: ${envelope.gatewayId}`,
          // );
          return;
        }

        if (cache.add(shaHash(envelope))) {
          // periodically print the nodeDB to the console
          //console.log(JSON.stringify(nodeDB));
        }

        meshPacketQueue.add(envelope, topic, "socalmesh");
      }
    }
  } catch (err) {
    logger.error("Error: " + String(err));
    Sentry.captureException(err);
  }
});

function shaHash(serviceEnvelope: ServiceEnvelope) {
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify(serviceEnvelope));
  return hash.digest("hex");
}

function processPacketGroup(packetGroup: PacketGroup) {
  const packet = packetGroup.serviceEnvelopes[0].packet;
  const portnum = packet?.decoded?.portnum;

  if (portnum === 1) {
    processTextMessage(packetGroup);
  } else if (portnum === 3) {
    // we used to insert positions in to the postresdb, but no more this is a just a logger
  } else if (portnum === 4) {
    const user = User.decode(packet.decoded.payload);
    const from = nodeId2hex(packet.from);
    updateNodeDB(from, user.longName, user, packet.hopStart);
  } else {
    // logger.debug(
    //   `MessageId: ${packetGroup.id} Unknown portnum ${portnum} from ${prettyNodeName(
    //     packet.from,
    //   )}`,
    // );
  }
}

function createNonce(packetId, fromNode) {
  // Expand packetId to 64 bits
  const packetId64 = BigInt(packetId);

  // Initialize block counter (32-bit, starts at zero)
  const blockCounter = 0;

  // Create a buffer for the nonce
  const buf = Buffer.alloc(16);

  // Write packetId, fromNode, and block counter to the buffer
  buf.writeBigUInt64LE(packetId64, 0);
  buf.writeUInt32LE(fromNode, 8);
  buf.writeUInt32LE(blockCounter, 12);

  return buf;
}

/**
 * References:
 * https://github.com/crypto-smoke/meshtastic-go/blob/develop/radio/aes.go#L42
 * https://github.com/pdxlocations/Meshtastic-MQTT-Connect/blob/main/meshtastic-mqtt-connect.py#L381
 */
function decrypt(packet) {
  // attempt to decrypt with all available decryption keys
  for (const decryptionKey of decryptionKeys) {
    try {
      // console.log(`using decryption key: ${decryptionKey}`);
      // convert encryption key to buffer
      const key = Buffer.from(decryptionKey, "base64");

      // create decryption iv/nonce for this packet
      const nonceBuffer = createNonce(packet.id, packet.from);

      // create aes-128-ctr decipher
      const decipher = crypto.createDecipheriv("aes-128-ctr", key, nonceBuffer);

      // decrypt encrypted packet
      const decryptedBuffer = Buffer.concat([
        decipher.update(packet.encrypted),
        decipher.final(),
      ]);

      // parse as data message
      return Data.decode(decryptedBuffer);
    } catch (e) {
      // console.log(e);
    }
  }

  // couldn't decrypt
  return null;
}