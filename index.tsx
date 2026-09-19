/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Nays
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { useTimer } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import { User } from "@vencord/discord-types";
import { Alerts, moment, PresenceStore, RelationshipStore, showToast, Tooltip } from "@webpack/common";

import managedStyle from "./styles.css?managed";

const cl = classNameFactory("vc-lastonline-");

const STORE_KEY = "LastOnline_lastSeen";
const HEARTBEAT_KEY = "LastOnline_heartbeat";
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
const REFRESH_INTERVAL = 30 * SECOND;
const GAP_THRESHOLD = 2 * MINUTE;

const UNCERTAIN_HINT = "The client was not running for part of this window, so this is an upper bound";
const SUB_MINUTE = "<1m";

interface Sighting {
    seen: number;
    exact: boolean;
}

let sightings: Record<string, Sighting> = {};
const online = new Set<string>();

let dirty = false;
let lastTick = 0;
let tickTimer: ReturnType<typeof setInterval>;

function ClearButton() {
    return <Button variant="dangerSecondary" onClick={confirmClear}>Clear stored data</Button>;
}

const settings = definePluginSettings({
    memberList: {
        type: OptionType.BOOLEAN,
        description: "Show in the guild member list.",
        default: true,
        restartNeeded: true
    },
    dmList: {
        type: OptionType.BOOLEAN,
        description: "Show in the DM list.",
        default: true,
        restartNeeded: true
    },
    friendsList: {
        type: OptionType.BOOLEAN,
        description: "Show in the friends list.",
        default: true,
        restartNeeded: true
    },
    profile: {
        type: OptionType.BOOLEAN,
        description: "Show in profiles.",
        default: true,
        restartNeeded: true
    },
    uncertain: {
        type: OptionType.SELECT,
        description: "How to show timestamps that span a period the client was closed for.",
        options: [
            { label: "Prefix them with <", value: "marker", default: true },
            { label: "Fade them out", value: "dim" },
            { label: "Hide them", value: "hide" }
        ]
    },
    friendsOnly: {
        type: OptionType.BOOLEAN,
        description: "Only remember friends. Turning this on also forgets everyone else right away.",
        default: false,
        onChange(on: boolean) {
            if (on) forgetStrangers();
        }
    },
    retention: {
        type: OptionType.SLIDER,
        description: "Forget last online times older than this many days.",
        markers: [7, 14, 30, 60, 90],
        default: 30,
        onChange: prune
    },
    clear: {
        type: OptionType.COMPONENT,
        description: "Forget every last online time collected so far. The plugin starts learning again right away.",
        component: ClearButton
    }
});

async function confirmClear() {
    const confirmed = await Alerts.confirm({
        title: "Clear stored data",
        body: "This forgets every last online time the plugin has collected. It starts learning again right away.",
        confirmText: "Clear"
    });
    if (!confirmed) return;

    sightings = {};
    dirty = false;
    await DataStore.del(STORE_KEY);
    showToast("Cleared last online data");
}

function save() {
    if (dirty) {
        DataStore.set(STORE_KEY, sightings);
        dirty = false;
    }

    DataStore.set(HEARTBEAT_KEY, Date.now());
}

function forget(id: string) {
    delete sightings[id];
    dirty = true;
}

function prune() {
    const expired = Date.now() - settings.store.retention * DAY;

    for (const id in sightings) {
        if (sightings[id].seen <= expired) forget(id);
    }
}

function forgetStrangers() {
    for (const id in sightings) {
        if (!RelationshipStore.isFriend(id)) forget(id);
    }
}

function invalidate() {
    for (const id in sightings) sightings[id].exact = false;
    dirty = true;
}

function tick() {
    const now = Date.now();

    if (now - lastTick > GAP_THRESHOLD) invalidate();
    lastTick = now;

    prune();
    save();
}

function onPresence(userId: string, status: string) {
    const wasOnline = online.delete(userId);
    const isOnline = status !== "offline";

    if (isOnline) online.add(userId);
    else if (!wasOnline) return;

    sightings[userId] = { seen: Date.now(), exact: !isOnline };
    dirty = true;
}

function ago(timestamp: number) {
    const minutes = Math.floor((Date.now() - timestamp) / MINUTE);
    if (minutes < 1) return SUB_MINUTE;
    if (minutes < 60) return `${minutes}m`;

    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

const LastOnlineIndicator = ErrorBoundary.wrap(({ userId }: { userId: string; }) => {
    useTimer({ interval: REFRESH_INTERVAL });
    const { uncertain } = settings.use(["uncertain"]);

    const sighting = sightings[userId];
    if (sighting == null) return null;

    const { seen, exact } = sighting;
    const text = ago(seen);
    const date = moment(seen).format("LLL");

    return (
        <Tooltip text={exact ? `Went offline ${date}` : `Was still online ${date}. ${UNCERTAIN_HINT}`}>
            {props => (
                <div {...props} className={cl("subtext", { uncertain: !exact && uncertain === "dim" })}>
                    Online <strong>{!exact && uncertain === "marker" && text !== SUB_MINUTE ? `<${text}` : text} ago</strong>
                </div>
            )}
        </Tooltip>
    );
}, { noop: true });

export default definePlugin({
    name: "LastOnline",
    description: "Shows how long ago someone was last online, in the member list, DM list, friends list and profiles.",
    authors: [{ name: "Nays", id: 344871509677965313n }],
    tags: ["Friends"],
    settings,
    managedStyle,

    patches: [
        {
            find: ".MEMBER_LIST_ITEM_AVATAR_DECORATION_PADDING)",
            replacement: {
                match: /subText:(?=\(0,\i\.jsx\)\(\i,\{hideSubtext:[^{}]{0,150}?user:(\i)[,}])/,
                replace: "subText:$self.indicator($1)??"
            },
            predicate: () => settings.store.memberList
        },
        {
            find: "PrivateChannel.renderAvatar",
            replacement: {
                match: /(?<=\{user:(\i),[^{}]{0,150}?\}\)):null(?=,name:)/,
                replace: ":$self.indicator($1)"
            },
            predicate: () => settings.store.dmList
        },
        {
            find: "peopleListItemRef",
            replacement: {
                match: /\{(?=[^{}]{0,120}?user:(\i)[,}])(?=[^{}]{0,120}?userIgnored:(\i)[,}])[^{}]{0,150}?\}=\i,\{voiceChannel:\i\}=\(0,\i\.\i\)\(\{userId:\i\?\.id\}\);/,
                replace: "$&{let vcLastOnline=!$2&&$self.indicator($1);if(vcLastOnline)return vcLastOnline}"
            },
            predicate: () => settings.store.friendsList
        },
        {
            find: 'sm:"heading-lg/bold"',
            replacement: {
                match: /\(0,\i\.jsx\)\(\i,\{(?=[^{}]{0,150}?usernameIcon:)(?=[^{}]{0,150}?user:(\i)[,}])[^{}]{0,200}?\}\)/,
                replace: "$&,$self.indicator($1)"
            },
            predicate: () => settings.store.profile
        }
    ],

    flux: {
        PRESENCE_UPDATES({ updates }: { updates: { user: { id: string; }; status: string; }[]; }) {
            const { friendsOnly } = settings.store;

            for (const { user, status } of updates) {
                if (!friendsOnly || RelationshipStore.isFriend(user.id)) onPresence(user.id, status);
            }
        }
    },

    async start() {
        const [stored, heartbeat] = await Promise.all([
            DataStore.get<Record<string, Sighting>>(STORE_KEY),
            DataStore.get<number>(HEARTBEAT_KEY)
        ]);

        for (const id in stored) sightings[id] ??= stored[id];
        prune();
        if (settings.store.friendsOnly) forgetStrangers();

        if (heartbeat != null && Date.now() - heartbeat > GAP_THRESHOLD) invalidate();

        const { statuses } = PresenceStore.getState();
        for (const id in statuses) {
            if (statuses[id] !== "offline") online.add(id);
        }

        lastTick = Date.now();
        tickTimer = setInterval(tick, MINUTE);
    },

    stop() {
        clearInterval(tickTimer);
        save();

        sightings = {};
        online.clear();
    },

    indicator(user?: User) {
        if (user == null || PresenceStore.getStatus(user.id) !== "offline") return null;

        const sighting = sightings[user.id];
        if (sighting == null || (!sighting.exact && settings.store.uncertain === "hide")) return null;

        return <LastOnlineIndicator userId={user.id} />;
    }
});
