export const demoUser = { id: "1001", name: "Анастасия Филимонова" };
export const demoFamily = {
  id: "demo",
  name: "Семья Филимоновых",
  owner_id: "1001",
};
export const demoMembers = [
  { ...demoUser, gift_count: 6 },
  { id: "1002", name: "Александр Филимонов", gift_count: 4 },
  { id: "1003", name: "Мария Филимонова", gift_count: 3 },
  { id: "1004", name: "Михаил Филимонов", gift_count: 5 },
];
export const demoGifts = [
  {
    id: "demo1",
    title: "Наушники для моих прогулок",
    price_minor: 24900,
    currency: "EUR",
    priority: 3,
    description: "В молочном цвете. Чтобы любимая музыка всегда была рядом.",
    photo:
      "https://images.unsplash.com/photo-1546435770-a3e426bf472b?w=700&auto=format&fit=crop&q=85",
  },
  {
    id: "demo2",
    title: "Немного магии в каждом кадре",
    price_minor: 8900,
    currency: "EUR",
    priority: 3,
    description: "Моментальная камера. Сохранять наши семейные моменты.",
    photo:
      "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=700&auto=format&fit=crop&q=85",
  },
  {
    id: "demo3",
    title: "Кофе, книга и никуда не спешить",
    price_minor: 2400,
    currency: "EUR",
    priority: 2,
    description: "Красивая керамическая чашка ручной работы.",
    photo:
      "https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?w=700&auto=format&fit=crop&q=85",
  },
  {
    id: "demo4",
    title: "Тот самый аромат для дома",
    price_minor: 3500,
    currency: "EUR",
    priority: 2,
    description: "Свеча с ароматом хлопка или сандала.",
    photo:
      "https://images.unsplash.com/photo-1603006905003-be475563bc59?w=700&auto=format&fit=crop&q=85",
  },
  {
    id: "demo5",
    title: "Истории для долгих вечеров",
    price_minor: 2200,
    currency: "EUR",
    priority: 1,
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
  created_at: 0,
  updated_at: 0,
}));
