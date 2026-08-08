/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Nays
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { classes } from "@utils/misc";
import { useForceUpdater } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import { User } from "@vencord/discord-types";
import { PresenceStore, Tooltip, useEffect } from "@webpack/common";

import managedStyle from "./styles.css?managed";

const cl = classNameFactory("vc-lastonline-");

const STORE_KEY = "LastOnline_lastSeen";
const HEARTBEAT_KEY = "LastOnline_heartbeat";
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const REFRESH_INTERVAL = 30 * SECOND;
const GAP_THRESHOLD = 2 * MINUTE;
const EXPIRY = 30 * 24 * 60 * MINUTE;

const UNCERTAIN_HINT = "The client was not running for part of this window, so this is an upper bound";
const SUB_MINUTE = "<1m";

interface Sighting {
    seen: number;
    exact: boolean;
}

let sightings: Record<string, Sighting> = {};
const online = new Set<string>();
const listeners = new Set<() => void>();

let dirty = false;
let lastTick = 0;
let saveTimer: ReturnType<typeof setInterval>;
let refreshTimer: ReturnType<typeof setInterval>;

const settings = definePluginSettings({
    memberList: {
        type: OptionType.BOOLEAN,
        description: "Show in the guild member list",
        default: true,
        restartNeeded: true
    },
    dmList: {
        type: OptionType.BOOLEAN,
        description: "Show in the DM list",
        default: true,
        restartNeeded: true
    },
    friendsList: {
        type: OptionType.BOOLEAN,
        description: "Show in the friends list",
        default: true,
        restartNeeded: true
    },
    profile: {
        type: OptionType.BOOLEAN,
        description: "Show in profiles",
        default: true,
        restartNeeded: true
    },
    uncertain: {
        type: OptionType.SELECT,
        description: "How to show timestamps that span a period the client was closed for",
        options: [
            { label: "Prefix them with <", value: "marker", default: true },
            { label: "Fade them out", value: "dim" },
            { label: "Hide them", value: "hide" }
        ]
    }
});

function save() {
    if (dirty) {
        DataStore.set(STORE_KEY, sightings);
        dirty = false;
    }

    DataStore.set(HEARTBEAT_KEY, Date.now());
}

function prune() {
    const expired = Date.now() - EXPIRY;

    for (const id in sightings) {
        if (sightings[id].seen > expired) continue;

        delete sightings[id];
        dirty = true;
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

function refresh() {
    for (const update of listeners) update();
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
    const forceUpdate = useForceUpdater();

    useEffect(() => {
        listeners.add(forceUpdate);
        return () => { listeners.delete(forceUpdate); };
    }, []);

    const sighting = sightings[userId];
    if (sighting == null) return null;

    const { seen, exact } = sighting;
    const { uncertain } = settings.store;
    const text = ago(seen);

    return (
        <Tooltip text={UNCERTAIN_HINT} shouldShow={!exact}>
            {props => (
                <div {...props} className={classes(cl("subtext"), !exact && uncertain === "dim" && cl("uncertain"))}>
                    Online <strong>{!exact && uncertain === "marker" && text !== SUB_MINUTE ? `<${text}` : text} ago</strong>
                </div>
            )}
        </Tooltip>
    );
}, { noop: true });

export default definePlugin({
    name: "LastOnline",
    description: "Shows how long ago someone was last online, in the member list, DM list, friends list and profiles",
    authors: [{ name: "Nays", id: 344871509677965313n }],
    settings,
    managedStyle,

    patches: [
        {
            find: ".MEMBER_LIST_ITEM_AVATAR_DECORATION_PADDING)",
            replacement: {
                match: /subText:(?=\(0,\i\.jsx\)\(\i,\{hideSubtext:[^{}]{0,150}?user:(\i)[,}])/,
                replace: "subText:$self.shouldShow($1)?$self.renderIndicator($1):"
            },
            predicate: () => settings.store.memberList
        },
        {
            find: "PrivateChannel.renderAvatar",
            replacement: {
                match: /"aria-label":(\i)\.username.{0,100}?,subText:/,
                replace: "$&$self.shouldShow($1)?$self.renderIndicator($1):"
            },
            predicate: () => settings.store.dmList
        },
        {
            find: "peopleListItemRef",
            replacement: {
                match: /user:(\i),userIgnored:(\i)\}=\i,\{voiceChannel:\i\}=\(0,\i\.\i\)\(\{userId:\i\?\.id\}\);/,
                replace: "$&if(!$2&&$self.shouldShow($1))return $self.renderIndicator($1);"
            },
            predicate: () => settings.store.friendsList
        },
        {
            find: 'sm:"heading-lg/bold"',
            replacement: {
                match: /\(0,\i\.jsx\)\(\i,\{user:(\i),usernameIcon:\i,pronouns:\i,[^{}]{0,120}?onClose:\i,trailing:\i\}\)/,
                replace: "$&,$self.shouldShow($1)?$self.renderIndicator($1):null"
            },
            predicate: () => settings.store.profile
        }
    ],

    flux: {
        PRESENCE_UPDATES({ updates }: { updates: { user: { id: string; }; status: string; }[]; }) {
            for (const { user, status } of updates) onPresence(user.id, status);
        }
    },

    async start() {
        const [stored, heartbeat] = await Promise.all([
            DataStore.get<Record<string, number | Sighting>>(STORE_KEY),
            DataStore.get<number>(HEARTBEAT_KEY)
        ]);

        sightings = {};
        for (const id in stored) {
            const entry = stored[id];
            sightings[id] = typeof entry === "number" ? { seen: entry, exact: false } : entry;
        }
        prune();

        if (heartbeat != null && Date.now() - heartbeat > GAP_THRESHOLD) invalidate();

        const { statuses } = PresenceStore.getState();
        for (const id in statuses) {
            if (statuses[id] !== "offline") online.add(id);
        }

        lastTick = Date.now();
        saveTimer = setInterval(tick, MINUTE);
        refreshTimer = setInterval(refresh, REFRESH_INTERVAL);
    },

    stop() {
        clearInterval(saveTimer);
        clearInterval(refreshTimer);
        save();

        sightings = {};
        online.clear();
        listeners.clear();
    },

    shouldShow(user?: User) {
        if (user == null || PresenceStore.getStatus(user.id) !== "offline") return false;

        const sighting = sightings[user.id];
        if (sighting == null) return false;

        return sighting.exact || settings.store.uncertain !== "hide";
    },

    renderIndicator(user: User) {
        return <LastOnlineIndicator userId={user.id} />;
    }
});
