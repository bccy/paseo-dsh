import type { RpcOutput } from "@getpaseo/plugin";
import { openExternalUrl, useRpc, useTranslation } from "@getpaseo/plugin/client";
import { copyText, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import {
  cancelSignInRpc,
  startSignInRpc,
  submitSignInRpc,
  type AccountSummary,
  type AccountsState,
} from "../../shared/antigravity/contracts";
import { relative } from "./format";
import { displayLabel } from "./labels";
import { errorMessage, messages } from "./messages";
import { font, mono, radius, space, tint, type Colors } from "./theme";
import { Button, Callout, Muted } from "./ui";

type Session = RpcOutput<typeof startSignInRpc>;

const RETRYABLE_INPUT_PREFIX = "Invalid input: ";

function Step({
  colors,
  number,
  title,
  body,
  done = false,
  children,
}: {
  colors: Colors;
  number: number;
  title: string;
  body?: string;
  done?: boolean;
  children?: ReactNode;
}) {
  return (
    <View style={{ flexDirection: "row", gap: space.md }}>
      <View
        style={{
          width: 26,
          height: 26,
          borderRadius: 13,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: done ? colors.accent : tint(colors.accent, 0.15),
        }}
      >
        <Text style={{ ...font.small, fontWeight: "700", color: done ? colors.accentForeground : colors.accent }}>
          {number}
        </Text>
      </View>
      <View style={{ flex: 1, gap: space.sm }}>
        <View style={{ gap: 2 }}>
          <Text style={{ ...font.heading, color: colors.foreground }}>{title}</Text>
          {body ? <Muted colors={colors}>{body}</Muted> : null}
        </View>
        {children}
      </View>
    </View>
  );
}

export function SignIn({
  account,
  colors,
  accept,
  close,
}: {
  account: AccountSummary;
  colors: Colors;
  accept(state: AccountsState): void;
  close(): void;
}) {
  const start = useRpc(startSignInRpc);
  const submit = useRpc(submitSignInRpc);
  const cancel = useRpc(cancelSignInRpc);
  const toast = useToast();
  const { t, locale } = useTranslation(messages);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionAlive, setSessionAlive] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const active = useRef(true);
  const login = useRef<string | null>(null);
  const accountName = displayLabel(account.label, t, account.kind);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let disposed = false;
    active.current = true;
    setError("");
    setSession(null);
    setSessionAlive(false);
    setOpened(false);
    void start({ accountId: account.id })
      .then((result) => {
        if (disposed) return cancel({ loginId: result.loginId }).then(() => undefined);
        login.current = result.loginId;
        setSession(result);
        setSessionAlive(true);
        return undefined;
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(errorMessage(reason));
      });
    return () => {
      disposed = true;
      active.current = false;
      const loginId = login.current;
      login.current = null;
      if (loginId) void cancel({ loginId }).catch(() => undefined);
    };
  }, [account.id, attempt, start, cancel]);

  const expired = session ? Date.parse(session.expiresAt) <= now : false;

  async function finish() {
    if (!login.current || busy) return;
    const trimmed = code.trim();
    if (!trimmed) return;
    if (/[\r\n]/.test(trimmed)) {
      setError(t("signin.singleLine"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const state = await submit({ loginId: login.current, code: trimmed });
      login.current = null;
      setSessionAlive(false);
      accept(state);
      if (active.current) {
        toast.show(t("signin.done", { label: accountName }), { variant: "success" });
        close();
      }
    } catch (reason) {
      if (active.current) {
        const raw = errorMessage(reason);
        // Validation errors never send anything to agy, so the sign-in process is still waiting.
        const retryable = raw.includes(RETRYABLE_INPUT_PREFIX);
        setError(retryable ? raw.replace(RETRYABLE_INPUT_PREFIX, "") : raw);
        if (!retryable) {
          // agy exits after a rejected code; the next try needs a fresh link.
          login.current = null;
          setSessionAlive(false);
        }
      }
    } finally {
      if (active.current) setBusy(false);
    }
  }

  function restart() {
    setCode("");
    setAttempt((value) => value + 1);
  }

  return (
    <Modal open title={t("signin.title", { label: accountName })} onOpenChange={(open) => { if (!open && !busy) close(); }}>
      <Modal.Content>
        {!session && !error ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.lg }}>
            <ActivityIndicator color={colors.accent} />
            <Muted colors={colors}>{t("signin.preparing")}</Muted>
          </View>
        ) : null}

        {session ? (
          <View style={{ gap: space.xl }}>
            <Step colors={colors} number={1} done={opened} title={t("signin.step1Title")}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                <Button
                  colors={colors}
                  variant={opened ? "secondary" : "primary"}
                  icon="ExternalLink"
                  label={t("signin.open")}
                  disabled={expired}
                  onPress={() => {
                    setOpened(true);
                    void openExternalUrl(session.url).catch((reason: unknown) => setError(errorMessage(reason)));
                  }}
                />
                <Button
                  colors={colors}
                  variant="ghost"
                  icon="Copy"
                  label={t("signin.copy")}
                  disabled={expired}
                  onPress={() => {
                    void copyText(session.url)
                      .then(() => toast.show(t("signin.copied")))
                      .catch((reason: unknown) => setError(errorMessage(reason)));
                  }}
                />
              </View>
            </Step>
            <Step colors={colors} number={2} title={t("signin.step2Title")}>
              <TextInput
                accessibilityLabel={t("signin.step2Title")}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                maxLength={16384}
                editable={!busy && !expired && sessionAlive}
                value={code}
                onChangeText={setCode}
                onSubmitEditing={() => void finish()}
                placeholder={t("signin.placeholder")}
                placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
                style={{
                  fontFamily: mono,
                  fontSize: 13,
                  color: colors.foreground,
                  backgroundColor: colors.surface0,
                  borderColor: colors.border,
                  borderWidth: 1,
                  borderRadius: radius.md,
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm + 2,
                }}
              />
            </Step>
            <Muted colors={colors} small>
              {expired ? t("signin.expired") : t("signin.expires", { time: relative(session.expiresAt, now, locale) })}
            </Muted>
          </View>
        ) : null}

        {error ? (
          <Callout colors={colors} tone="danger" icon="CircleAlert" title={error} />
        ) : null}

        <View style={{ flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: space.sm, marginTop: space.sm }}>
          <Button colors={colors} variant="ghost" label={t("dialog.cancel")} disabled={busy} onPress={close} />
          {!sessionAlive || error || expired ? (
            <Button colors={colors} variant="secondary" icon="RotateCcw" label={t("signin.restart")} disabled={busy} onPress={restart} />
          ) : null}
          {session && !expired && sessionAlive ? (
            <Button
              colors={colors}
              variant="primary"
              icon={busy ? undefined : "Check"}
              label={busy ? t("signin.waiting") : t("signin.submit")}
              loading={busy}
              disabled={!code.trim()}
              onPress={() => void finish()}
            />
          ) : null}
        </View>
      </Modal.Content>
    </Modal>
  );
}
