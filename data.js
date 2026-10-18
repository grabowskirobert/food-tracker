// Plan data from teach/zdrowie lessons/0001 (jadłospis na 8 tygodni).
// Foods: values per 100 g. k kcal, p protein, f fat, s saturated fat, b fibre (g); vf counts toward veg & fruit;
// pc grams per piece, for amounts given as a count.
export const FOODS = {
  oats: {"n": "Płatki owsiane (suche)", "k": 370, "p": 13, "f": 7, "s": 1.2, "b": 10, "vf": false},
  skyr: {"n": "Skyr naturalny", "k": 63, "p": 11, "f": 0.2, "s": 0.1, "b": 0, "vf": false},
  banana: {"n": "Banan", "k": 90, "p": 1, "f": 0.3, "s": 0.1, "b": 2.6, "vf": true, "pc": 120},
  apple: {"n": "Jabłko", "k": 52, "p": 0.3, "f": 0.2, "s": 0, "b": 2.4, "vf": true, "pc": 150},
  berries: {"n": "Owoce jagodowe (mrożone)", "k": 50, "p": 0.7, "f": 0.3, "s": 0, "b": 2.5, "vf": true},
  walnut: {"n": "Orzechy włoskie", "k": 650, "p": 15, "f": 65, "s": 6, "b": 7, "vf": false},
  almond: {"n": "Migdały", "k": 580, "p": 21, "f": 50, "s": 3.8, "b": 12.5, "vf": false},
  chicken: {"n": "Pierś z kurczaka (surowa)", "k": 110, "p": 23, "f": 1.5, "s": 0.4, "b": 0, "vf": false},
  salmon: {"n": "Łosoś (surowy)", "k": 200, "p": 20, "f": 13, "s": 3, "b": 0, "vf": false},
  rice: {"n": "Ryż brązowy (suchy)", "k": 360, "p": 7.5, "f": 2.7, "s": 0.5, "b": 3.5, "vf": false},
  potato: {"n": "Ziemniaki (gotowane)", "k": 85, "p": 2, "f": 0.1, "s": 0, "b": 1.8, "vf": false},
  veg: {"n": "Warzywa (mieszane)", "k": 30, "p": 2, "f": 0.3, "s": 0, "b": 2.5, "vf": true},
  rapeseed: {"n": "Olej rzepakowy", "k": 884, "p": 0, "f": 100, "s": 7, "b": 0, "vf": false},
  olive: {"n": "Oliwa z oliwek", "k": 884, "p": 0, "f": 100, "s": 14, "b": 0, "vf": false},
  rye: {"n": "Chleb razowy", "k": 240, "p": 8, "f": 1.5, "s": 0.3, "b": 7, "vf": false},
  egg: {"n": "Jajka (całe)", "k": 143, "p": 12.6, "f": 9.5, "s": 3.1, "b": 0, "vf": false, "pc": 60},
  quark: {"n": "Twaróg chudy", "k": 100, "p": 19, "f": 1, "s": 0.6, "b": 0, "vf": false},
  pbutter: {"n": "Masło orzechowe 100%", "k": 590, "p": 25, "f": 50, "s": 10, "b": 6, "vf": false},
  lentil: {"n": "Soczewica (sucha)", "k": 350, "p": 25, "f": 1.1, "s": 0.2, "b": 11, "vf": false}
};

// Meal items: [food id, grams].
export const PLANS = {
  A: { name: "Dzień A", meals: [
    { name: "Śniadanie", items: [["oats", 80], ["skyr", 150], ["banana", 120], ["walnut", 20]] },
    { name: "Obiad", items: [["chicken", 130], ["rice", 120], ["veg", 250], ["rapeseed", 10]] },
    { name: "Przekąska", items: [["quark", 100], ["apple", 150], ["almond", 25]] },
    { name: "Kolacja", items: [["rye", 80], ["egg", 120], ["veg", 120], ["olive", 10], ["pbutter", 20]] }
  ] },
  B: { name: "Dzień B", meals: [
    { name: "Śniadanie", items: [["oats", 80], ["skyr", 150], ["banana", 120], ["walnut", 20]] },
    { name: "Obiad (ryba)", items: [["salmon", 150], ["potato", 450], ["veg", 200], ["rapeseed", 10]] },
    { name: "Przekąska", items: [["quark", 100], ["berries", 150], ["almond", 25]] },
    { name: "Kolacja (strączkowe)", items: [["lentil", 60], ["rye", 70], ["veg", 120], ["olive", 10]] }
  ] }
};

// kcal [min, max], protein [min], satpct [max % of energy], fibre [min, max], vf [min g].
export const TARGETS = {"kcal": [2250, 2550], "protein": [110], "satpct": [7], "fibre": [25, 40], "vf": [400]};
