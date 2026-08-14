import { useEffect, useMemo, useState } from "react";
import { MoonStar, Search } from "lucide-react";
import { EmptyState, PageHeading } from "../components/AppShell";
import { supabase } from "../lib/supabase";
import type { DreamItem } from "../types";

export function DreamPage() {
  const [items, setItems] = useState<DreamItem[]>([]); const [search, setSearch] = useState(""); const [category, setCategory] = useState("All");
  useEffect(() => { void supabase.from("dream100_items").select("*").eq("is_active",true).order("title_mm").then(({data}) => setItems((data || []) as DreamItem[])); }, []);
  const categories = useMemo(() => ["All", ...new Set(items.map((i) => i.category).filter(Boolean) as string[])], [items]);
  const filtered = useMemo(() => { const term = search.normalize("NFC").toLocaleLowerCase(); return items.filter((item) => (category === "All" || item.category === category) && !term || ((item.title_mm + " " + (item.title_en || "") + " " + item.keywords.join(" ")).normalize("NFC").toLocaleLowerCase().includes(term) && (category === "All" || item.category === category))); }, [items,search,category]);
  return <><PageHeading eyebrow="DREAM DICTIONARY" title="အိပ်မက်100 🌙" description="အိပ်မက်တွေထဲက သင်္ကေတတွေကို ပျော်ပျော်ပါးပါး ရှာဖွေကြည့်ပါ။"/>
    <section className="dream-search"><MoonStar/><div><Search/><input value={search} onChange={(e)=>setSearch(e.target.value)} placeholder="Search your dream... ဥပမာ မြွေ"/></div><p>ဖျော်ဖြေရေးအတွက်သာ · အမှန်တကယ် ထီရလဒ်ကို မခန့်မှန်းနိုင်ပါ</p></section>
    <div className="category-scroll">{categories.map((name)=><button className={category===name?"active":""} onClick={()=>setCategory(name)} key={name}>{name}</button>)}</div>
    <section className="dream-grid">{!filtered.length ? <EmptyState icon="🌙" title="ရှာမတွေ့သေးပါ" body="အခြားစကားလုံးတစ်ခုနဲ့ ပြန်ရှာကြည့်ပါ။"/> : filtered.map((item)=><article className="dream-card" key={item.id}><div className="dream-emoji">{item.emoji || "🌙"}</div><div><small>{item.category}</small><h3>{item.title_mm}</h3>{item.title_en && <p className="english-title">{item.title_en}</p>}<div className="dream-numbers">{item.numbers.map((number)=><b key={number}>{number}</b>)}</div><p>{item.short_description}</p></div></article>)}</section></>;
}
