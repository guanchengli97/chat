import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { generateClient } from 'aws-amplify/data';
import { getCurrentUser } from 'aws-amplify/auth';
import { getUrl, uploadData } from 'aws-amplify/storage';
import {
  Check,
  LogOut,
  MessageCircle,
  Search,
  Send,
  Upload,
  UserRound,
  ArrowLeft,
  Trash2,
  X,
} from 'lucide-react';
import type { Schema } from '../amplify/data/resource';
import './App.css';

type UserProfile = Schema['UserProfile']['type'];
type FriendRequest = Schema['FriendRequest']['type'];
type Contact = Schema['Contact']['type'];
type Conversation = Schema['Conversation']['type'];
type Message = Schema['Message']['type'];

const client = generateClient<Schema>();
const maxMessageLength = 5000;
const messagePageSize = 20;

function App() {
  return (
    <Authenticator signUpAttributes={['email']}>
      {({ signOut }) => <ChatShell onSignOut={signOut ?? (() => undefined)} />}
    </Authenticator>
  );
}

function ChatShell({ onSignOut }: { onSignOut: () => void }) {
  const [currentUserId, setCurrentUserId] = useState('');
  const [email, setEmail] = useState('');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const [searchResults, setSearchResults] = useState<UserProfile[]>([]);
  const [activeContactId, setActiveContactId] = useState('');
  const [mobileConversationOpen, setMobileConversationOpen] = useState(false);
  const [activeConversation, setActiveConversation] =
    useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageNextToken, setMessageNextToken] = useState<string | null>(null);
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [draft, setDraft] = useState('');
  const [conversationNotice, setConversationNotice] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('正在连接...');
  const [searchStatus, setSearchStatus] = useState('输入昵称或邮箱后搜索');
  const [sendingRequestUserIds, setSendingRequestUserIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [optimisticRequestUserIds, setOptimisticRequestUserIds] = useState<
    Set<string>
  >(() => new Set());
  const [respondingRequestIds, setRespondingRequestIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [optimisticHandledRequestIds, setOptimisticHandledRequestIds] = useState<
    Set<string>
  >(() => new Set());
  const [deletingContactIds, setDeletingContactIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [removedContactUserIds, setRemovedContactUserIds] = useState<Set<string>>(
    () => new Set(),
  );
  const syncingContactUserIdsRef = useRef(new Set<string>());
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const hasPositionedMessagesRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);

  const activeContact = contacts.find((item) => item.id === activeContactId);

  const incomingRequests = useMemo(
    () =>
      requests
        .filter(
          (request) =>
            request.toUserId === currentUserId &&
            request.status === 'PENDING' &&
            !optimisticHandledRequestIds.has(request.id),
        )
        .sort(sortByCreatedAtDesc),
    [currentUserId, optimisticHandledRequestIds, requests],
  );

  const outgoingRequestUserIds = useMemo(
    () =>
      new Set(
        [
          ...requests
            .filter(
              (request) =>
                request.fromUserId === currentUserId &&
                request.status === 'PENDING',
            )
            .map((request) => request.toUserId),
          ...optimisticRequestUserIds,
        ],
      ),
    [currentUserId, optimisticRequestUserIds, requests],
  );

  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      const user = await getCurrentUser();
      if (!mounted) return;

      setCurrentUserId(user.userId);
      setEmail(user.signInDetails?.loginId ?? '');
      setStatus('已连接');
    }

    bootstrap().catch((error: unknown) => {
      console.error(error);
      setStatus('无法读取当前用户');
    });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!currentUserId) return;

    async function ensureProfile() {
      const { data: existing } = await client.models.UserProfile.list({
        filter: { userId: { eq: currentUserId } },
      });

      const firstProfile = existing[0];
      if (firstProfile) {
        setProfile(firstProfile);
        setDisplayName(firstProfile.displayName);
        await loadAvatar(firstProfile.avatarKey);
        return;
      }

      const fallbackName = email.split('@')[0] || '新用户';
      const { data: created } = await client.models.UserProfile.create({
        userId: currentUserId,
        email,
        displayName: fallbackName,
        statusMessage: '在线',
      });

      setProfile(created);
      setDisplayName(created?.displayName ?? fallbackName);
    }

    ensureProfile().catch((error: unknown) => {
      console.error(error);
      setStatus('资料初始化失败');
    });
  }, [currentUserId, email]);

  useEffect(() => {
    if (!currentUserId) return;

    let disposed = false;

    async function loadContacts() {
      const { data } = await client.models.Contact.listContactByOwnerId({
        ownerId: currentUserId,
      });

      if (disposed) return;

      const loadedContacts = data
        .filter(Boolean)
        .filter((contact) => !removedContactUserIds.has(contact.contactUserId));
      setContacts((previous) => {
        const normalizedContacts = normalizeContacts(loadedContacts);
        const retainedPrevious = previous.filter(
          (contact) => !removedContactUserIds.has(contact.contactUserId),
        );
        return normalizedContacts.length === 0 && retainedPrevious.length > 0
          ? retainedPrevious
          : normalizedContacts;
      });
    }

    async function loadRequests() {
      const [incoming, outgoing] = await Promise.all([
        client.models.FriendRequest.listFriendRequestByToUserId({
          toUserId: currentUserId,
        }),
        client.models.FriendRequest.listFriendRequestByFromUserId({
          fromUserId: currentUserId,
        }),
      ]);

      if (disposed) return;

      const byId = new Map<string, FriendRequest>();
      [...incoming.data, ...outgoing.data].filter(Boolean).forEach((request) => {
        byId.set(request.id, request);
      });
      setRequests(
        [...byId.values()].filter((request) => {
          const otherUserId =
            request.fromUserId === currentUserId
              ? request.toUserId
              : request.fromUserId;
          return !removedContactUserIds.has(otherUserId);
        }),
      );
      setOptimisticRequestUserIds((previous) => {
        const next = new Set(previous);
        outgoing.data.filter(Boolean).forEach((request) => {
          next.delete(request.toUserId);
        });
        return next.size === previous.size ? previous : next;
      });
      setOptimisticHandledRequestIds((previous) => {
        const next = new Set(previous);
        incoming.data
          .filter((request) => request?.status !== 'PENDING')
          .forEach((request) => {
            next.delete(request.id);
          });
        return next.size === previous.size ? previous : next;
      });
    }

    loadContacts().catch((error: unknown) => {
      console.error(error);
      setStatus('联系人同步失败');
    });

    loadRequests().catch((error: unknown) => {
      console.error(error);
      setStatus('好友请求同步失败');
    });

    const contactTimer = window.setInterval(() => {
      loadContacts().catch((error: unknown) => {
        console.error(error);
        setStatus('联系人同步失败');
      });
    }, 3000);

    const requestTimer = window.setInterval(() => {
      loadRequests().catch((error: unknown) => {
        console.error(error);
        setStatus('好友请求同步失败');
      });
    }, 5000);

    return () => {
      disposed = true;
      window.clearInterval(contactTimer);
      window.clearInterval(requestTimer);
    };
  }, [currentUserId, removedContactUserIds]);

  useEffect(() => {
    if (!activeConversation?.id) return;

    let disposed = false;

    async function loadLatestMessages() {
      if (!activeConversation?.id) return;

      const { data, nextToken } =
        await client.models.Message.listMessageByConversationIdAndCreatedAt(
          { conversationId: activeConversation.id },
          { limit: messagePageSize, sortDirection: 'DESC' },
        );

      if (disposed) return;

      setMessages(sortMessages(data.filter(Boolean)));
      setMessageNextToken(nextToken ?? null);
    }

    async function pollLatestMessages() {
      if (!activeConversation?.id) return;

      const { data } =
        await client.models.Message.listMessageByConversationIdAndCreatedAt(
          { conversationId: activeConversation.id },
          { limit: messagePageSize, sortDirection: 'DESC' },
        );

      if (!disposed) {
        setMessages((previous) => mergeMessages(previous, data.filter(Boolean)));
      }
    }

    loadLatestMessages().catch((error: unknown) => {
      console.error(error);
      setStatus('消息同步失败');
    });

    const messageTimer = window.setInterval(() => {
      pollLatestMessages().catch((error: unknown) => {
        console.error(error);
        setStatus('消息同步失败');
      });
    }, 2000);

    return () => {
      disposed = true;
      window.clearInterval(messageTimer);
    };
  }, [activeConversation?.id]);

  useEffect(() => {
    hasPositionedMessagesRef.current = false;
    shouldStickToBottomRef.current = true;
  }, [activeConversation?.id]);

  useEffect(() => {
    if (!activeContact || messages.length === 0 || hasPositionedMessagesRef.current) {
      return;
    }

    const container = messagesContainerRef.current;
    if (!container) return;

    const firstUnread = messages.find(
      (message) =>
        message.senderId !== currentUserId &&
        new Date(message.createdAt).getTime() >
          new Date(activeContact.lastReadAt ?? 0).getTime(),
    );

    if (firstUnread) {
      const element = container.querySelector<HTMLElement>(
        `[data-message-id="${firstUnread.id}"]`,
      );
      element?.scrollIntoView({ block: 'start' });
    } else {
      container.scrollTop = container.scrollHeight;
    }

    hasPositionedMessagesRef.current = true;
  }, [activeContact, currentUserId, messages]);

  useEffect(() => {
    if (!activeContact || messages.length === 0 || !hasPositionedMessagesRef.current) {
      return;
    }

    if (shouldStickToBottomRef.current) {
      const container = messagesContainerRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    }
  }, [activeContact, currentUserId, messages]);

  useEffect(() => {
    if (!activeContact || messages.length === 0) return;

    const hasUnreadVisibleMessage = messages.some(
      (message) =>
        message.senderId !== currentUserId &&
        new Date(message.createdAt).getTime() >
          new Date(activeContact.lastReadAt ?? 0).getTime(),
    );

    if (hasUnreadVisibleMessage) {
      markContactRead(activeContact);
    }
  }, [activeContact, currentUserId, messages]);

  useEffect(() => {
    if (!currentUserId || contacts.length === 0) {
      return;
    }

    let disposed = false;

    async function loadUnreadCounts() {
      const entries = await Promise.all(
        contacts.map(async (contact) => {
          if (!contact.conversationId || contact.id === activeContactId) {
            return [contact.id, 0] as const;
          }

          const { data } = await client.models.Message.list({
            filter: {
              conversationId: { eq: contact.conversationId },
              senderId: { ne: currentUserId },
              createdAt: { gt: contact.lastReadAt ?? new Date(0).toISOString() },
            },
          });

          return [contact.id, data.filter(Boolean).length] as const;
        }),
      );

      if (!disposed) {
        setUnreadCounts(Object.fromEntries(entries));
      }
    }

    loadUnreadCounts().catch((error: unknown) => {
      console.error(error);
      setStatus('未读消息同步失败');
    });

    const unreadTimer = window.setInterval(() => {
      loadUnreadCounts().catch((error: unknown) => {
        console.error(error);
        setStatus('未读消息同步失败');
      });
    }, 3000);

    return () => {
      disposed = true;
      window.clearInterval(unreadTimer);
    };
  }, [activeContactId, contacts, currentUserId]);

  const syncAcceptedContact = useCallback(async (request: FriendRequest) => {
    if (!request.conversationId) return;

    syncingContactUserIdsRef.current.add(request.toUserId);

    try {
      const { data: existing } = await client.models.Contact.list({
        filter: {
          ownerId: { eq: currentUserId },
          contactUserId: { eq: request.toUserId },
        },
      });

      if (existing.some(Boolean)) return;

      await client.models.Contact.create({
        ownerId: currentUserId,
        contactUserId: request.toUserId,
        displayName: request.toDisplayName,
        avatarKey: request.toAvatarKey,
        conversationId: request.conversationId,
        lastReadAt: new Date().toISOString(),
      });
    } catch (error: unknown) {
      console.error(error);
      setStatus('同步联系人失败');
    } finally {
      syncingContactUserIdsRef.current.delete(request.toUserId);
    }
  }, [currentUserId]);

  useEffect(() => {
    if (!currentUserId) return;

    const acceptedOutgoing = requests.filter(
      (request) =>
        request.fromUserId === currentUserId &&
        request.status === 'ACCEPTED' &&
        request.conversationId &&
        !contacts.some((contact) => contact.contactUserId === request.toUserId) &&
        !removedContactUserIds.has(request.toUserId) &&
        !syncingContactUserIdsRef.current.has(request.toUserId),
    );

    acceptedOutgoing.forEach((request) => {
      syncAcceptedContact(request);
    });
  }, [contacts, currentUserId, removedContactUserIds, requests, syncAcceptedContact]);

  async function loadAvatar(key?: string | null) {
    if (!key) {
      setAvatarUrl('');
      return;
    }

    const result = await getUrl({ path: key });
    setAvatarUrl(result.url.toString());
  }

  async function saveProfile() {
    if (!profile || !displayName.trim()) return;

    const { data: updated } = await client.models.UserProfile.update({
      id: profile.id,
      displayName: displayName.trim(),
    });

    if (updated) setProfile(updated);
  }

  async function uploadAvatar(file?: File) {
    if (!file || !profile) return;

    const extension = file.name.split('.').pop() || 'png';
    const path = `avatars/${currentUserId}/profile.${extension}`;
    await uploadData({ path, data: file, options: { contentType: file.type } })
      .result;

    const { data: updated } = await client.models.UserProfile.update({
      id: profile.id,
      avatarKey: path,
    });

    if (updated) setProfile(updated);
    await loadAvatar(path);
  }

  async function searchUsers() {
    const term = search.trim();
    setSearchResults([]);

    if (term.length < 2) {
      setSearchStatus('至少输入 2 个字符');
      return;
    }

    setSearchStatus('正在搜索...');
    const { data } = await client.models.UserProfile.list({
      filter: {
        or: [
          { displayName: { contains: term } },
          { email: { contains: term.toLowerCase() } },
        ],
      },
      limit: 10,
    });

    const results = data.filter((person) => person.userId !== currentUserId);
    setSearchResults(results);
    setSearchStatus(results.length ? '搜索结果' : '没有找到用户');
  }

  async function sendFriendRequest(person: UserProfile) {
    if (!profile || person.userId === currentUserId) return;

    setRemovedContactUserIds((previous) => {
      if (!previous.has(person.userId)) return previous;
      const next = new Set(previous);
      next.delete(person.userId);
      return next;
    });

    const isContact = contacts.some(
      (contact) => contact.contactUserId === person.userId,
    );
    if (
      isContact ||
      outgoingRequestUserIds.has(person.userId) ||
      sendingRequestUserIds.has(person.userId)
    ) {
      return;
    }

    setSendingRequestUserIds((previous) => new Set(previous).add(person.userId));

    try {
      await client.models.FriendRequest.create({
        fromUserId: currentUserId,
        fromDisplayName: profile.displayName,
        fromAvatarKey: profile.avatarKey,
        toUserId: person.userId,
        toDisplayName: person.displayName,
        toAvatarKey: person.avatarKey,
        status: 'PENDING',
        participantIds: [currentUserId, person.userId].sort(),
        createdAt: new Date().toISOString(),
      });
      setOptimisticRequestUserIds((previous) =>
        new Set(previous).add(person.userId),
      );
    } catch (error: unknown) {
      console.error(error);
      setStatus('好友请求发送失败');
    } finally {
      setSendingRequestUserIds((previous) => {
        const next = new Set(previous);
        next.delete(person.userId);
        return next;
      });
    }
  }

  async function respondToRequest(
    request: FriendRequest,
    status: 'ACCEPTED' | 'REJECTED',
  ) {
    if (respondingRequestIds.has(request.id)) return;

    setRespondingRequestIds((previous) => new Set(previous).add(request.id));
    setRemovedContactUserIds((previous) => {
      if (!previous.has(request.fromUserId)) return previous;
      const next = new Set(previous);
      next.delete(request.fromUserId);
      return next;
    });

    try {
      if (status === 'REJECTED') {
        await client.models.FriendRequest.update({
          id: request.id,
          status,
        });
        setOptimisticHandledRequestIds((previous) =>
          new Set(previous).add(request.id),
        );
        return;
      }

      const memberIds = [request.fromUserId, request.toUserId].sort();
      const conversation = await createConversation(memberIds);

      await client.models.FriendRequest.update({
        id: request.id,
        status,
        conversationId: conversation?.id,
      });

      await client.models.Contact.create({
        ownerId: request.toUserId,
        contactUserId: request.fromUserId,
        displayName: request.fromDisplayName,
        avatarKey: request.fromAvatarKey,
        conversationId: conversation?.id,
        lastReadAt: new Date().toISOString(),
      });
      setOptimisticHandledRequestIds((previous) =>
        new Set(previous).add(request.id),
      );
    } catch (error: unknown) {
      console.error(error);
      setStatus('好友请求处理失败');
    } finally {
      setRespondingRequestIds((previous) => {
        const next = new Set(previous);
        next.delete(request.id);
        return next;
      });
    }
  }

  async function createConversation(memberIds: string[]) {
    const normalizedMemberIds = [...memberIds].sort();
    const existingConversation = await findDirectConversation(normalizedMemberIds);

    if (existingConversation) {
      const restoredDeletedByUserIds = removeIds(
        existingConversation.deletedByUserIds,
        normalizedMemberIds,
      );

      if (
        restoredDeletedByUserIds.length !==
        (existingConversation.deletedByUserIds ?? []).filter(Boolean).length
      ) {
        const { data: restoredConversation } =
          await client.models.Conversation.update({
            id: existingConversation.id,
            deletedByUserIds: restoredDeletedByUserIds,
          });

        return restoredConversation ?? existingConversation;
      }

      return existingConversation;
    }

    const { data } = await client.models.Conversation.create({
      type: 'DIRECT',
      memberIds: normalizedMemberIds,
      deletedByUserIds: [],
    });

    return data;
  }

  async function openConversation(contact: Contact) {
    const isSameContact = contact.id === activeContactId;
    setMobileConversationOpen(true);
    setActiveContactId(contact.id);
    setConversationNotice('');
    markContactRead(contact);

    if (contact.conversationId) {
      if (isSameContact && activeConversation?.id === contact.conversationId) {
        return;
      }

      setMessages([]);
      setMessageNextToken(null);
      const { data } = await client.models.Conversation.get({
        id: contact.conversationId,
      });
      setActiveConversation(data);
      return;
    }

    if (isSameContact && activeConversation?.memberIds.includes(contact.contactUserId)) {
      return;
    }

    setMessages([]);
    setMessageNextToken(null);
    const memberIds = [currentUserId, contact.contactUserId].sort();
    const conversation = await createConversation(memberIds);
    setActiveConversation(conversation);

    if (conversation?.id) {
      await client.models.Contact.update({
        id: contact.id,
        conversationId: conversation.id,
        lastReadAt: new Date().toISOString(),
      });
    }
  }

  function closeMobileConversation() {
    setMobileConversationOpen(false);
    setActiveContactId('');
    setActiveConversation(null);
    setMessages([]);
    setMessageNextToken(null);
    setConversationNotice('');
  }

  async function markContactRead(contact: Contact) {
    const now = new Date().toISOString();
    setUnreadCounts((previous) => ({ ...previous, [contact.id]: 0 }));
    setContacts((previous) =>
      previous.map((item) =>
        item.id === contact.id ? { ...item, lastReadAt: now } : item,
      ),
    );

    await client.models.Contact.update({
      id: contact.id,
      lastReadAt: now,
    }).catch((error: unknown) => {
      console.error(error);
    });
  }

  async function deleteContact(contact: Contact) {
    if (deletingContactIds.has(contact.id)) return;

    const confirmed = window.confirm(`删除联系人 ${contact.displayName}？`);
    if (!confirmed) return;

    setDeletingContactIds((previous) => new Set(previous).add(contact.id));
    setRemovedContactUserIds((previous) =>
      new Set(previous).add(contact.contactUserId),
    );

    try {
      const [contactResult, incomingRequestsResult, outgoingRequestsResult] =
        await Promise.all([
          client.models.Contact.list({
            filter: {
              ownerId: { eq: currentUserId },
              contactUserId: { eq: contact.contactUserId },
            },
          }),
          client.models.FriendRequest.listFriendRequestByToUserId({
            toUserId: currentUserId,
          }),
          client.models.FriendRequest.listFriendRequestByFromUserId({
            fromUserId: currentUserId,
          }),
        ]);

      const contactsToDelete = contactResult.data.filter(Boolean);
      const requestsToDelete = [
        ...incomingRequestsResult.data,
        ...outgoingRequestsResult.data,
      ]
        .filter(Boolean)
        .filter(
          (request) =>
            (request.fromUserId === currentUserId &&
              request.toUserId === contact.contactUserId) ||
            (request.fromUserId === contact.contactUserId &&
              request.toUserId === currentUserId),
        );
      const conversationUpdate = contact.conversationId
        ? client.models.Conversation.update({
            id: contact.conversationId,
            deletedByUserIds: mergeUniqueIds(
              activeConversation?.id === contact.conversationId
                ? activeConversation.deletedByUserIds
                : undefined,
              currentUserId,
            ),
          })
        : Promise.resolve();

      await Promise.all([
        conversationUpdate,
        ...contactsToDelete.map((item) =>
          client.models.Contact.delete({ id: item.id }),
        ),
        ...requestsToDelete.map((request) =>
          client.models.FriendRequest.delete({ id: request.id }),
        ),
      ]);

      setContacts((previous) =>
        previous.filter((item) => item.contactUserId !== contact.contactUserId),
      );
      setRequests((previous) =>
        previous.filter(
          (request) =>
            !(
              (request.fromUserId === currentUserId &&
                request.toUserId === contact.contactUserId) ||
              (request.fromUserId === contact.contactUserId &&
                request.toUserId === currentUserId)
            ),
        ),
      );
      setUnreadCounts((previous) => {
        const next = { ...previous };
        contactsToDelete.forEach((item) => {
          delete next[item.id];
        });
        delete next[contact.id];
        return next;
      });

      if (activeContactId === contact.id) {
        setActiveContactId('');
        setMobileConversationOpen(false);
        setActiveConversation(null);
        setMessages([]);
        setMessageNextToken(null);
      }
    } catch (error: unknown) {
      console.error(error);
      setStatus('联系人删除失败');
      setRemovedContactUserIds((previous) => {
        const next = new Set(previous);
        next.delete(contact.contactUserId);
        return next;
      });
    } finally {
      setDeletingContactIds((previous) => {
        const next = new Set(previous);
        next.delete(contact.id);
        return next;
      });
    }
  }

  async function loadOlderMessages() {
    if (
      !activeConversation?.id ||
      !messageNextToken ||
      isLoadingOlderMessages
    ) {
      return;
    }

    const container = messagesContainerRef.current;
    const previousScrollHeight = container?.scrollHeight ?? 0;

    setIsLoadingOlderMessages(true);

    try {
      const { data, nextToken } =
        await client.models.Message.listMessageByConversationIdAndCreatedAt(
          { conversationId: activeConversation.id },
          {
            limit: messagePageSize,
            nextToken: messageNextToken,
            sortDirection: 'DESC',
          },
        );

      setMessages((previous) => mergeMessages(data.filter(Boolean), previous));
      setMessageNextToken(nextToken ?? null);

      window.requestAnimationFrame(() => {
        const currentContainer = messagesContainerRef.current;
        if (!currentContainer) return;

        currentContainer.scrollTop =
          currentContainer.scrollHeight - previousScrollHeight;
      });
    } catch (error: unknown) {
      console.error(error);
      setStatus('更早消息加载失败');
    } finally {
      setIsLoadingOlderMessages(false);
    }
  }

  async function sendMessage() {
    const body = draft.trim();
    if (!body || !activeConversation?.id) return;
    if (body.length > maxMessageLength) {
      setConversationNotice(`消息最多 ${maxMessageLength} 个字符`);
      setStatus(`消息最多 ${maxMessageLength} 个字符`);
      return;
    }

    setConversationNotice('');

    try {
      const { data: latestConversation } = await client.models.Conversation.get({
        id: activeConversation.id,
      });
      const conversation = latestConversation ?? activeConversation;
      const otherMemberId = getOtherMemberId(conversation, currentUserId);

      if (
        otherMemberId &&
        conversation.deletedByUserIds?.includes(otherMemberId)
      ) {
        setConversationNotice('消息发送失败：对方已删除联系人');
        setStatus('消息发送失败：对方已删除联系人');
        return;
      }

      const now = new Date().toISOString();

      await client.models.Message.create({
        conversationId: conversation.id,
        senderId: currentUserId,
        senderName: profile?.displayName ?? email,
        body,
        messageType: 'TEXT',
        createdAt: now,
        memberIds: [...conversation.memberIds],
      });

      await client.models.Conversation.update({
        id: conversation.id,
        lastMessageText: body,
        lastMessageAt: now,
      });

      setDraft('');
      setActiveConversation(conversation);
    } catch (error: unknown) {
      console.error(error);
      setConversationNotice('消息发送失败，请稍后重试');
      setStatus('消息发送失败');
    }
  }

  return (
    <main className={mobileConversationOpen ? 'chat-app chat-open' : 'chat-app'}>
      <aside className="sidebar">
        <section className="profile">
          <div className="avatar">
            {avatarUrl ? <img src={avatarUrl} alt="" /> : <UserRound size={24} />}
          </div>
          <div className="profile-fields">
            <input
              value={displayName}
              onBlur={saveProfile}
              onChange={(event) => setDisplayName(event.target.value)}
              aria-label="昵称"
            />
            <span>{status}</span>
          </div>
          <label className="icon-button" title="上传头像">
            <Upload size={18} />
            <input
              type="file"
              accept="image/*"
              onChange={(event) => uploadAvatar(event.target.files?.[0])}
            />
          </label>
          <button className="icon-button" type="button" onClick={onSignOut}>
            <LogOut size={18} />
          </button>
        </section>

        <section className="search-box">
          <Search size={18} />
          <input
            value={search}
            placeholder="搜索昵称或邮箱"
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') searchUsers();
            }}
          />
          <button type="button" onClick={searchUsers}>
            搜索
          </button>
        </section>

        <section className="contacts">
          <h2>联系人</h2>
          {contacts.map((contact) => (
            <div
              className={contact.id === activeContactId ? 'contact-row active' : 'contact-row'}
              key={contact.id}
            >
              <button
                className="contact-main"
                type="button"
                onClick={() => openConversation(contact)}
              >
              <span className="contact-avatar">
                {(contact.displayName || '?').slice(0, 1).toUpperCase()}
              </span>
              <span>
                <strong>{contact.displayName}</strong>
                <small>{contact.conversationId ? '聊天已创建' : '点击开始聊天'}</small>
              </span>
              {contact.id !== activeContactId && unreadCounts[contact.id] ? (
                <span className="unread-badge">
                  {unreadCounts[contact.id] > 99 ? '99+' : unreadCounts[contact.id]}
                </span>
              ) : null}
              </button>
              <button
                className="contact-delete"
                type="button"
                title="删除联系人"
                aria-label={`删除联系人 ${contact.displayName}`}
                disabled={deletingContactIds.has(contact.id)}
                onClick={() => deleteContact(contact)}
              >
                {deletingContactIds.has(contact.id) ? (
                  <span className="spinner" />
                ) : (
                  <Trash2 size={16} />
                )}
              </button>
            </div>
          ))}
        </section>

        <section className="people">
          <h2>好友请求</h2>
          {incomingRequests.length === 0 ? (
            <p className="muted">暂无待处理请求</p>
          ) : (
            incomingRequests.map((request) => (
              <div className="request-row" key={request.id}>
                <span>{request.fromDisplayName}</span>
                {respondingRequestIds.has(request.id) ? (
                  <span className="mini-spinner">
                    <span className="spinner" />
                  </span>
                ) : (
                  <>
                    <button
                      className="mini-button"
                      type="button"
                      title="接受"
                      onClick={() => respondToRequest(request, 'ACCEPTED')}
                    >
                      <Check size={15} />
                    </button>
                    <button
                      className="mini-button"
                      type="button"
                      title="拒绝"
                      onClick={() => respondToRequest(request, 'REJECTED')}
                    >
                      <X size={15} />
                    </button>
                  </>
                )}
              </div>
            ))
          )}

          <h2>{searchStatus}</h2>
          {searchResults.map((person) => {
            const isContact = contacts.some(
              (contact) => contact.contactUserId === person.userId,
            );
            const isPending = outgoingRequestUserIds.has(person.userId);
            const isSending = sendingRequestUserIds.has(person.userId);
            return (
              <button
                key={person.id}
                type="button"
                disabled={isContact || isPending || isSending}
                onClick={() => sendFriendRequest(person)}
              >
                {isSending ? <span className="spinner" /> : <UserRound size={16} />}
                <span>
                  {person.displayName}
                  <small>
                    {isContact
                      ? '已是联系人'
                      : isSending
                        ? '发送中...'
                        : isPending
                          ? '请求已发送'
                          : '发送请求'}
                  </small>
                </span>
              </button>
            );
          })}
        </section>
      </aside>

      <section className="conversation">
        {activeContact ? (
          <>
            <header>
              <button
                className="back-button"
                type="button"
                onClick={closeMobileConversation}
              >
                <ArrowLeft size={20} />
              </button>
              <div>
                <h1>{activeContact.displayName}</h1>
                <span>{messages.length} 条消息</span>
              </div>
              <MessageCircle size={22} />
            </header>

            <div
              className="messages"
              ref={messagesContainerRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                shouldStickToBottomRef.current =
                  element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                if (element.scrollTop < 24) {
                  loadOlderMessages();
                }
              }}
            >
              {isLoadingOlderMessages ? (
                <div className="loading-row">加载更早消息...</div>
              ) : null}
              {messages.map((message) => (
                <article
                  className={
                    message.senderId === currentUserId ? 'message mine' : 'message'
                  }
                  data-message-id={message.id}
                  key={message.id}
                >
                  <small>{message.senderName}</small>
                  <p>{message.body}</p>
                </article>
              ))}
            </div>

            {conversationNotice ? (
              <div className="conversation-notice">{conversationNotice}</div>
            ) : null}

            <footer>
              <textarea
                value={draft}
                placeholder="输入消息"
                maxLength={maxMessageLength}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    sendMessage();
                  }
                }}
              />
              <button type="button" onClick={sendMessage}>
                <Send size={18} />
                发送
              </button>
            </footer>
          </>
        ) : (
          <div className="empty-state">
            <MessageCircle size={42} />
            <h1>选择联系人开始聊天</h1>
            <p>先搜索用户并发送好友请求，对方接受后会出现在联系人里。</p>
          </div>
        )}
      </section>
    </main>
  );
}

function sortByCreatedAtDesc(left: FriendRequest, right: FriendRequest) {
  return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
}

function sortMessages(items: Message[]) {
  return [...items].sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  );
}

function mergeMessages(left: Message[], right: Message[]) {
  const byId = new Map<string, Message>();

  [...left, ...right].forEach((item) => {
    byId.set(item.id, item);
  });

  return sortMessages([...byId.values()]);
}

async function findDirectConversation(memberIds: string[]) {
  const { data } = await client.models.Conversation.list();
  const normalizedMemberIds = [...memberIds].sort();

  return data
    .filter(Boolean)
    .find((conversation) =>
      hasSameMembers(conversation.memberIds, normalizedMemberIds),
    );
}

function hasSameMembers(
  currentMemberIds: (string | null)[] | null | undefined,
  targetMemberIds: string[],
) {
  const normalizedCurrentMemberIds = (currentMemberIds ?? [])
    .filter(Boolean)
    .sort();

  return (
    normalizedCurrentMemberIds.length === targetMemberIds.length &&
    normalizedCurrentMemberIds.every(
      (memberId, index) => memberId === targetMemberIds[index],
    )
  );
}

function getOtherMemberId(conversation: Conversation, currentUserId: string) {
  return conversation.memberIds.find((memberId) => memberId !== currentUserId) ?? '';
}

function mergeUniqueIds(items: (string | null)[] | null | undefined, id: string) {
  return [...new Set([...(items ?? []).filter(Boolean), id])];
}

function removeIds(
  items: (string | null)[] | null | undefined,
  idsToRemove: string[],
) {
  const idsToRemoveSet = new Set(idsToRemove);
  return (items ?? []).filter((item): item is string => {
    if (!item) return false;
    return !idsToRemoveSet.has(item);
  });
}

function normalizeContacts(items: Contact[]) {
  const byContactUserId = new Map<string, Contact>();

  items.forEach((item) => {
    const existing = byContactUserId.get(item.contactUserId);
    if (!existing) {
      byContactUserId.set(item.contactUserId, item);
      return;
    }

    const shouldReplace =
      (!existing.conversationId && Boolean(item.conversationId)) ||
      (Boolean(existing.conversationId) === Boolean(item.conversationId) &&
        new Date(item.createdAt).getTime() > new Date(existing.createdAt).getTime());

    if (shouldReplace) {
      byContactUserId.set(item.contactUserId, item);
    }
  });

  return [...byContactUserId.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

export default App;
