import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, KeyRound, LoaderCircle, Save, Trash2, UserRoundPen } from "lucide-react";
import type { AuthSession, CurrentUserProfile, UpdateCurrentUserProfile } from "@paperclipai/shared";
import { AuthApiError, authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { assetsApi } from "@/api/assets";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { InboxAgentPolicyControl } from "@/components/InboxAgentPolicyControl";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function deriveInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function ProfileSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const avatarInputId = useId();
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Profile" },
    ]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    const session = sessionQuery.data;
    if (!session) return;
    setName(session.user.name ?? "");
    setImage(session.user.image ?? "");
  }, [sessionQuery.data]);

  function syncSessionProfile(profile: CurrentUserProfile) {
    queryClient.setQueryData<AuthSession | null>(queryKeys.auth.session, (current) => {
      if (!current) return current;
      return {
        ...current,
        user: {
          ...current.user,
          ...profile,
        },
      };
    });
  }

  async function persistProfile(input: UpdateCurrentUserProfile) {
    const profile = await authApi.updateProfile(input);
    syncSessionProfile(profile);
    return profile;
  }

  function resolveProfileName() {
    return name.trim() || sessionQuery.data?.user.name || "Board";
  }

  const updateMutation = useMutation({
    mutationFn: (input: UpdateCurrentUserProfile) => persistProfile(input),
    onSuccess: (profile) => {
      setActionError(null);
      setName(profile.name ?? "");
      setImage(profile.image ?? "");
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update profile.");
    },
  });

  const uploadAvatarMutation = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) {
        throw new Error("Select an organization before uploading a profile avatar.");
      }

      const asset = await assetsApi.uploadImage(
        selectedCompanyId,
        file,
        `profiles/${sessionQuery.data?.user.id ?? "board-user"}`,
      );
      return persistProfile({ name: resolveProfileName(), image: asset.contentPath });
    },
    onSuccess: (profile) => {
      setActionError(null);
      setName(profile.name ?? "");
      setImage(profile.image ?? "");
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to upload avatar.");
    },
  });

  const removeAvatarMutation = useMutation({
    mutationFn: () => persistProfile({ name: resolveProfileName(), image: null }),
    onSuccess: (profile) => {
      setActionError(null);
      setName(profile.name ?? "");
      setImage(profile.image ?? "");
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to remove avatar.");
    },
  });

  if (sessionQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading profile...</div>;
  }

  if (sessionQuery.error || !sessionQuery.data) {
    return (
      <div className="text-sm text-destructive">
        {sessionQuery.error instanceof Error ? sessionQuery.error.message : "Failed to load profile."}
      </div>
    );
  }

  const currentName = name.trim() || sessionQuery.data.user.name || "Board";
  const currentImage = image.trim() || null;
  const initials = deriveInitials(currentName);
  const isSavingProfile = updateMutation.isPending || uploadAvatarMutation.isPending || removeAvatarMutation.isPending;
  const uploadHint = selectedCompany
    ? `Stored in Paperclip file storage for ${selectedCompany.name}.`
    : "Select an organization to upload an avatar into Paperclip storage.";

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <UserRoundPen className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Profile</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Control how your account appears in the sidebar and other board surfaces.
        </p>
      </div>

      {actionError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      <section className="space-y-8">
        <Card className="block relative overflow-hidden rounded-(--rad-28) border-border/70">
          <div className="absolute inset-x-0 top-0 h-32 bg-(image:--gradient-extract-26)" />
          <div className="absolute inset-0 bg-(image:--gradient-extract-7)" />
          <div className="relative p-6 pt-10">
            <div className="flex flex-wrap items-end gap-5 rounded-(--rad-24) border border-border/70 bg-background/92 p-5 shadow-(--shadow-extract-18) backdrop-blur-sm">
              <div className="space-y-3">
                <label
                  htmlFor={avatarInputId}
                  className="group relative block cursor-pointer rounded-full focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background"
                >
                  <input
                    ref={avatarInputRef}
                    id={avatarInputId}
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    disabled={!selectedCompanyId || isSavingProfile}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      uploadAvatarMutation.mutate(file);
                      event.target.value = "";
                    }}
                  />
                  <span className="absolute inset-0 z-10 rounded-full bg-black/0 transition-colors group-hover:bg-black/14 group-focus-within:bg-black/14" />
                  <span className="absolute bottom-1 right-1 z-20 flex size-9 items-center justify-center rounded-full border border-background bg-primary text-primary-foreground shadow-sm">
                    {uploadAvatarMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Camera className="size-4" />}
                  </span>
                  <Avatar size="lg" className="data-[size=lg]:size-24 ring-4 ring-background shadow-xl">
                    {currentImage ? <AvatarImage src={currentImage} alt={currentName} /> : null}
                    <AvatarFallback>{initials}</AvatarFallback>
                  </Avatar>
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => avatarInputRef.current?.click()}
                    disabled={!selectedCompanyId || isSavingProfile}
                  >
                    {uploadAvatarMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Camera className="size-4" />}
                    {currentImage ? "Change photo" : "Upload photo"}
                  </Button>
                  {currentImage ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => removeAvatarMutation.mutate()}
                      disabled={isSavingProfile}
                    >
                      {removeAvatarMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                      Remove
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="min-w-0 flex-1 space-y-2 pb-1">
                <div>
                  <h2 className="truncate text-2xl font-semibold text-foreground">{currentName}</h2>
                  <p className="truncate text-sm text-muted-foreground">{sessionQuery.data.user.email ?? "No email"}</p>
                </div>
                <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                  Click the avatar to upload a new image. {uploadHint}
                </p>
              </div>
            </div>
          </div>
        </Card>

        <form
          className="grid gap-6 md:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            updateMutation.mutate({ name: resolveProfileName(), image: image.trim() || null });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="profile-name">Display name</Label>
            <Input
              id="profile-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              placeholder="Board"
            />
            <p className="text-xs text-muted-foreground">
              Shown in the sidebar account footer and comment author surfaces.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="profile-email">Email</Label>
            <Input
              id="profile-email"
              value={sessionQuery.data.user.email ?? ""}
              readOnly
              disabled
            />
            <p className="text-xs text-muted-foreground">
              Email is managed by your auth session and is read-only here.
            </p>
          </div>

          <div className="md:col-span-2 flex justify-end">
            <Button type="submit" disabled={isSavingProfile || !name.trim()}>
              {updateMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
              {updateMutation.isPending ? "Saving..." : "Save profile"}
            </Button>
          </div>
        </form>

        <ChangePasswordSection sessionId={sessionQuery.data.session?.id} />

        <InboxAgentPolicyControl companyId={selectedCompanyId} />
      </section>
    </div>
  );
}

// better-auth defaults (emailAndPassword.minPasswordLength / maxPasswordLength); the server stays the authority.
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

const PASSWORD_ERROR_MESSAGES: Record<string, string> = {
  INVALID_PASSWORD: "Current password is incorrect.",
  PASSWORD_TOO_SHORT: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
  PASSWORD_TOO_LONG: `New password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
  CREDENTIAL_ACCOUNT_NOT_FOUND: "This account has no password to change.",
};

/** Only a better-auth password session (browser sign-in) can call /change-password. */
export function canChangePassword(deploymentMode: string | undefined, sessionId: string | undefined) {
  return deploymentMode === "authenticated" && Boolean(sessionId?.startsWith("paperclip:session:"));
}

export function ChangePasswordSection({ sessionId }: { sessionId: string | undefined }) {
  const healthQuery = useQuery({ queryKey: queryKeys.health, queryFn: () => healthApi.get(), retry: false });
  if (!canChangePassword(healthQuery.data?.deploymentMode, sessionId)) return null;
  return <ChangePasswordForm />;
}

export function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [revokeOtherSessions, setRevokeOtherSessions] = useState(false);

  const mutation = useMutation({
    mutationFn: () => authApi.changePassword({ currentPassword, newPassword, revokeOtherSessions }),
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    },
  });

  function edit(setter: (value: string) => void) {
    return (event: { target: { value: string } }) => {
      if (mutation.isError || mutation.isSuccess) mutation.reset();
      setter(event.target.value);
    };
  }

  const errorCode = mutation.error instanceof AuthApiError ? mutation.error.code : null;
  const error = mutation.error
    ? (errorCode && PASSWORD_ERROR_MESSAGES[errorCode]) ||
      (mutation.error instanceof Error && mutation.error.message) ||
      "Failed to change password."
    : null;

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const tooShort = newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH;
  const tooLong = newPassword.length > MAX_PASSWORD_LENGTH;
  const canSubmit =
    currentPassword.length > 0 &&
    newPassword.length >= MIN_PASSWORD_LENGTH &&
    !tooLong &&
    newPassword === confirmPassword &&
    !mutation.isPending;

  return (
    <form
      className="space-y-4 rounded-(--rad-24) border border-border/70 p-5"
      aria-label="Change password"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-base font-semibold">Change password</h2>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>
      ) : null}
      {mutation.isSuccess ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">Password changed.</div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="current-password">Current password</Label>
          <Input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={edit(setCurrentPassword)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="new-password">New password</Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={edit(setNewPassword)}
          />
          {tooShort ? <p className="text-xs text-destructive">At least {MIN_PASSWORD_LENGTH} characters.</p> : null}
          {tooLong ? <p className="text-xs text-destructive">At most {MAX_PASSWORD_LENGTH} characters.</p> : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm-password">Repeat new password</Label>
          <Input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={edit(setConfirmPassword)}
          />
          {mismatch ? <p className="text-xs text-destructive">Passwords do not match.</p> : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              id="revoke-other-sessions"
              checked={revokeOtherSessions}
              onCheckedChange={(value) => setRevokeOtherSessions(value === true)}
            />
            Sign out other browser sessions
          </label>
          <p className="text-xs text-muted-foreground">
            Also renews this browser's session. Board API keys and connected app grants stay valid; revoke them separately.
          </p>
        </div>
        <Button type="submit" disabled={!canSubmit}>
          {mutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
          {mutation.isPending ? "Changing..." : "Change password"}
        </Button>
      </div>
    </form>
  );
}
