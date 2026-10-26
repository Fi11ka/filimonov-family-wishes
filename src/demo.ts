import { eventSpecs } from "../shared/events";
export const demoUser = {
  id: "1001",
  name: "Анастасия Филимонова",
  username: "nastya_f",
};
export const demoFriends = [
  {
    id: "1002",
    name: "Александр Филимонов",
    username: "sasha_f",
    gift_count: 4,
  },
  { id: "1003", name: "Мария Филимонова", username: "masha_f", gift_count: 3 },
  { id: "1004", name: "Михаил Филимонов", username: null, gift_count: 5 },
];
export const demoIncoming = [
  { id: "1005", name: "Дарина Филимонова", username: "darina_f" },
];
export const demoGifts = [
  {
    id: "demo1",
    title: "Наушники для моих прогулок",
    price_minor: 24900,
    currency: "EUR",
    priority: 5,
    description: "В молочном цвете. Чтобы любимая музыка всегда была рядом.",
    photo:
      "https://images.unsplash.com/photo-1546435770-a3e426bf472b?w=700&auto=format&fit=crop&q=85",
  },
  {
    id: "demo2",
    title: "Немного магии в каждом кадре",
    price_minor: 8900,
    currency: "EUR",
    priority: 5,
    description: "Моментальная камера. Сохранять наши семейные моменты.",
    photo:
      "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=700&auto=format&fit=crop&q=85",
  },
  {
    id: "demo3",
    title: "Кофе, книга и никуда не спешить",
    price_minor: 2400,
    currency: "EUR",
    priority: 4,
    description: "Красивая керамическая чашка ручной работы.",
    photo:
      "https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?w=700&auto=format&fit=crop&q=85",
  },
  {
    id: "demo4",
    title: "Тот самый аромат для дома",
    price_minor: 3500,
    currency: "EUR",
    priority: 3,
    description: "Свеча с ароматом хлопка или сандала.",
    photo:
      "https://images.unsplash.com/photo-1603006905003-be475563bc59?w=700&auto=format&fit=crop&q=85",
  },
  {
    id: "demo5",
    title: "Истории для долгих вечеров",
    price_minor: 2200,
    currency: "EUR",
    priority: 2,
    description: "Красивое издание любимой книги.",
    photo:
      "https://images.unsplash.com/photo-1544947950-fa07a98d237f?w=700&auto=format&fit=crop&q=85",
  },
  {
    id: "demo6",
    title: "Маленькое зелёное счастье",
    price_minor: 1800,
    currency: "EUR",
    priority: 1,
    description: "Растение в светлом керамическом горшке.",
    photo:
      "https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=700&auto=format&fit=crop&q=85",
  },
].map((g) => ({
  ...g,
  owner_id: "1001",
  has_photo: 1,
  shop_url: "",
  price_max_minor: null as number | null,
  price_range: 0,
  created_at: 0,
  updated_at: 0,
}));
demoGifts[3] = {
  ...demoGifts[3],
  price_minor: 2500,
  price_max_minor: 4500,
  price_range: 1,
};
export const demoArchive = [
  {
    ...demoGifts[0],
    id: "demo-archived",
    title: "Тёплый плед в клетку",
    description: "Подарили на Новый год — спасибо!",
    price_minor: 5900,
    archived_at: 1735689600,
    archive_reason: "gifted" as const,
    photo:
      "https://images.unsplash.com/photo-1580301762395-21ce84d00bc6?w=700&auto=format&fit=crop&q=85",
  },
];
/** «Мои брони» in the demo: a solo booking, a shared one and an invitation. */
export const demoBookings = [
  {
    gift_id: "demo-b1",
    role: "organizer" as const,
    title: "Шарф из мериноса",
    price_minor: 4500,
    currency: "EUR",
    owner_id: "1002",
    owner_name: "Александр Филимонов",
    organizer_name: null,
    archived: 0,
    owner_events: eventSpecs({}),
    members: [],
  },
  {
    gift_id: "demo-b2",
    role: "organizer" as const,
    title: "Кофемашина",
    price_minor: 32000,
    currency: "EUR",
    owner_id: "1003",
    owner_name: "Мария Филимонова",
    organizer_name: null,
    archived: 0,
    owner_events: eventSpecs({}),
    members: [
      { id: "1002", name: "Александр", username: "sasha_f", status: "joined" as const },
      { id: "1004", name: "Михаил", username: null, status: "invited" as const },
    ],
  },
  {
    gift_id: "demo-b3",
    role: "invited" as const,
    title: "Билеты в театр",
    price_minor: 12000,
    currency: "EUR",
    owner_id: "1004",
    owner_name: "Михаил Филимонов",
    organizer_name: "Мария",
    archived: 0,
    owner_events: [],
    members: [],
  },
];
