import { describe, expect, it } from "vitest";
import {
  formatPronunciations,
  normalizeText,
  parsePronunciations,
  numberToWords,
  ordinalToWords,
  stripMarkdown,
  yearToWords,
} from "../normalize";

describe("numberToWords", () => {
  it("handles small numbers", () => {
    expect(numberToWords(0)).toBe("zero");
    expect(numberToWords(7)).toBe("seven");
    expect(numberToWords(15)).toBe("fifteen");
    expect(numberToWords(42)).toBe("forty-two");
  });

  it("handles hundreds and thousands", () => {
    expect(numberToWords(100)).toBe("one hundred");
    expect(numberToWords(250)).toBe("two hundred fifty");
    expect(numberToWords(1250)).toBe("one thousand two hundred fifty");
    expect(numberToWords(1_000_000)).toBe("one million");
  });
});

describe("yearToWords", () => {
  it("reads years in pairs", () => {
    expect(yearToWords(2026)).toBe("twenty twenty-six");
    expect(yearToWords(1999)).toBe("nineteen ninety-nine");
    expect(yearToWords(1905)).toBe("nineteen oh five");
  });

  it("special-cases round and 200x years", () => {
    expect(yearToWords(2000)).toBe("two thousand");
    expect(yearToWords(2005)).toBe("two thousand five");
    expect(yearToWords(1900)).toBe("nineteen hundred");
  });
});

describe("ordinalToWords", () => {
  it("converts ordinals", () => {
    expect(ordinalToWords(1)).toBe("first");
    expect(ordinalToWords(3)).toBe("third");
    expect(ordinalToWords(12)).toBe("twelfth");
    expect(ordinalToWords(20)).toBe("twentieth");
    expect(ordinalToWords(21)).toBe("twenty-first");
  });
});

describe("normalizeText — numbers", () => {
  it("expands years", () => {
    expect(normalizeText("In 2026 we ship.")).toBe("In twenty twenty-six we ship.");
  });

  it("expands units", () => {
    expect(normalizeText("It needs 15GB of RAM.")).toBe(
      "It needs fifteen gigabytes of RAM."
    );
    expect(normalizeText("only 1 GB left")).toBe("only one gigabyte left");
  });

  it("expands currency", () => {
    expect(normalizeText("It costs $5.")).toBe("It costs five dollars.");
    expect(normalizeText("$5.50 each")).toBe("five dollars and fifty cents each");
    expect(normalizeText("a $3M budget")).toBe("a three million dollars budget");
    expect(normalizeText("$1,250.50 total")).toBe(
      "one thousand two hundred fifty dollars and fifty cents total"
    );
  });

  it("expands percentages", () => {
    expect(normalizeText("3.5% growth")).toBe("three point five percent growth");
    expect(normalizeText("100% done")).toBe("one hundred percent done");
  });

  it("expands ordinals and times", () => {
    expect(normalizeText("the 21st century")).toBe("the twenty-first century");
    expect(normalizeText("at 3:30 sharp")).toBe("at three thirty sharp");
  });

  it("expands plain and separated numbers", () => {
    expect(normalizeText("about 1,000 people")).toBe("about one thousand people");
    expect(normalizeText("wait 10-15 minutes")).toBe("wait ten-fifteen minutes");
  });

  it("leaves no digits behind", () => {
    const out = normalizeText(
      "In 2024, 3.5% of the $2,500 budget bought 15GB at 3:45, ranked 2nd of 1,000."
    );
    expect(out).not.toMatch(/\d/);
  });
});

describe("normalizeText — abbreviations", () => {
  it("expands common abbreviations", () => {
    expect(normalizeText("Fruit, e.g. apples.")).toBe("Fruit, for example, apples.");
    expect(normalizeText("Dr. Smith agrees.")).toBe("Doctor Smith agrees.");
    expect(normalizeText("Cats, dogs, etc.")).toBe("Cats, dogs, et cetera.");
    expect(normalizeText("A vs. B")).toBe("A versus B");
    expect(normalizeText("bread & butter")).toBe("bread and butter");
  });
});

describe("stripMarkdown / normalizeText — markdown", () => {
  it("strips headings, emphasis, code", () => {
    expect(normalizeText("# Big Title")).toBe("Big Title");
    expect(normalizeText("This is **bold** and *italic*.")).toBe(
      "This is bold and italic."
    );
    expect(normalizeText("run `npm install` now")).toBe("run npm install now");
  });

  it("keeps link text, drops URLs", () => {
    expect(normalizeText("See [the docs](https://example.com/docs).")).toBe(
      "See the docs."
    );
    expect(stripMarkdown("go to https://example.com now")).toBe("go to  now");
  });

  it("strips list markers", () => {
    expect(normalizeText("- first item\n- second item")).toBe(
      "first item\nsecond item"
    );
  });
});

describe("normalizeText — non-English languages", () => {
  it("skips English number/abbreviation expansion for Hindi", () => {
    expect(normalizeText("कीमत $5 है और 15GB चाहिए।", "hi")).toBe(
      "कीमत $5 है और 15GB चाहिए।"
    );
  });

  it("still strips markdown for Hindi", () => {
    expect(normalizeText("# शीर्षक — **मोटा** पाठ", "hi")).toBe("शीर्षक - मोटा पाठ");
  });
});

describe("normalizeText — punctuation", () => {
  it("converts smart quotes and dashes to ASCII", () => {
    expect(normalizeText("“Hello,” she said — twice.")).toBe(
      '"Hello," she said - twice.'
    );
    expect(normalizeText("it’s fine…")).toBe("it's fine...");
  });

  it("collapses whitespace", () => {
    expect(normalizeText("too   many    spaces")).toBe("too many spaces");
  });
});

describe("spoken forms", () => {
  it("spells initials the model would otherwise read as words", () => {
    expect(normalizeText("AI is changing IT.")).toBe("ay eye is changing eye tee.");
    expect(normalizeText("Use A.I. wisely")).toBe("Use ay eye wisely");
    expect(normalizeText("Two AIs and AI's future")).toBe("Two ay eyes and ay eye's future");
  });

  it("leaves the ordinary words alone", () => {
    expect(normalizeText("Is it ready? Fix it.")).toBe("Is it ready? Fix it.");
    expect(normalizeText("AIM for the CPU and NASA")).toBe("AIM for the CPU and NASA");
  });

  it("reads 365 in a product name as three sixty-five", () => {
    expect(normalizeText("M365 and Microsoft 365")).toBe(
      "em three sixty-five and Microsoft three sixty-five"
    );
    expect(normalizeText("Office 365 or O365")).toBe("Office three sixty-five or oh three sixty-five");
    // A plain count is still a count.
    expect(normalizeText("365 days")).toBe("three hundred sixty-five days");
  });

  it("only applies to English", () => {
    expect(normalizeText("AI र M365", "ne")).toBe("AI र M365");
  });
});

describe("respelled words", () => {
  it("writes Copilot the way the dictionary does, in any case", () => {
    expect(normalizeText("Copilot helps. Ask copilot anything.")).toBe(
      "co-pilot helps. Ask co-pilot anything."
    );
    expect(normalizeText("Microsoft Copilot 365")).toBe("Microsoft co-pilot three sixty-five");
  });

  it("splits product names at the capital the model would lose", () => {
    expect(normalizeText("Open SharePoint and OneDrive in PowerShell")).toBe(
      "Open Share Point and One Drive in Power Shell"
    );
    expect(normalizeText("YouTube and LinkedIn")).toBe("You Tube and Linked In");
  });

  it("leaves ordinary words, capitals and Mc names alone", () => {
    expect(normalizeText("Hello World from NASA and McDonald")).toBe(
      "Hello World from NASA and McDonald"
    );
  });

  it("reads iOS and macOS as their letters", () => {
    expect(normalizeText("iOS and macOS")).toBe("eye oh ess and mac oh ess");
  });
});

describe("the pronunciation list from Settings", () => {
  it("replaces a whole word, in any case", () => {
    const opts = { pronunciations: { Azure: "azh-er" } };
    expect(normalizeText("Azure and azure, not Azureish", "en", opts)).toBe(
      "azh-er and azh-er, not Azureish"
    );
  });

  it("overrides a built-in respelling", () => {
    const opts = { pronunciations: { Copilot: "koh pilot" } };
    expect(normalizeText("Copilot", "en", opts)).toBe("koh pilot");
  });

  it("overrides how initials are spelled", () => {
    const opts = { pronunciations: { AI: "A I" } };
    expect(normalizeText("AI is here", "en", opts)).toBe("A I is here");
  });

  it("matches a word written in capitals only in capitals", () => {
    const opts = { pronunciations: { IT: "eye tee" } };
    expect(normalizeText("IT fixed it", "en", opts)).toBe("eye tee fixed it");
  });

  it("does not expand a spoken form a second time", () => {
    // "A I" must not be re-read by the initialism rule as two words to spell.
    const opts = { pronunciations: { AI: "the AI system" } };
    expect(normalizeText("AI", "en", opts)).toBe("the AI system");
  });

  it("only applies to English", () => {
    expect(normalizeText("Copilot", "ne", { pronunciations: { Copilot: "x" } })).toBe("Copilot");
  });

  it("parses the settings text and ignores half-typed lines", () => {
    expect(parsePronunciations("Copilot = co-pilot\nAI=ay eye\n\nnot a rule\nEmpty =\n= nothing")).toEqual({
      Copilot: "co-pilot",
      AI: "ay eye",
    });
    expect(formatPronunciations({ Copilot: "co-pilot", AI: "ay eye" })).toBe(
      "Copilot = co-pilot\nAI = ay eye"
    );
  });
});
