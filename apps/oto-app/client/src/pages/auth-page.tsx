import { useState, useMemo } from "react";
import { Link, Redirect } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Loader2, ChevronDown, Check, Phone, Mail } from "lucide-react";

// ─── Country code data ────────────────────────────────────────────────────────

const COUNTRIES = [
  { code: "+66",  name: "Thailand",           flag: "🇹🇭" },
  { code: "+1",   name: "United States",       flag: "🇺🇸" },
  { code: "+1",   name: "Canada",              flag: "🇨🇦" },
  { code: "+44",  name: "United Kingdom",      flag: "🇬🇧" },
  { code: "+61",  name: "Australia",           flag: "🇦🇺" },
  { code: "+64",  name: "New Zealand",         flag: "🇳🇿" },
  { code: "+65",  name: "Singapore",           flag: "🇸🇬" },
  { code: "+60",  name: "Malaysia",            flag: "🇲🇾" },
  { code: "+62",  name: "Indonesia",           flag: "🇮🇩" },
  { code: "+63",  name: "Philippines",         flag: "🇵🇭" },
  { code: "+84",  name: "Vietnam",             flag: "🇻🇳" },
  { code: "+855", name: "Cambodia",            flag: "🇰🇭" },
  { code: "+856", name: "Laos",                flag: "🇱🇦" },
  { code: "+95",  name: "Myanmar",             flag: "🇲🇲" },
  { code: "+81",  name: "Japan",               flag: "🇯🇵" },
  { code: "+82",  name: "South Korea",         flag: "🇰🇷" },
  { code: "+86",  name: "China",               flag: "🇨🇳" },
  { code: "+852", name: "Hong Kong",           flag: "🇭🇰" },
  { code: "+853", name: "Macau",               flag: "🇲🇴" },
  { code: "+886", name: "Taiwan",              flag: "🇹🇼" },
  { code: "+91",  name: "India",               flag: "🇮🇳" },
  { code: "+92",  name: "Pakistan",            flag: "🇵🇰" },
  { code: "+880", name: "Bangladesh",          flag: "🇧🇩" },
  { code: "+94",  name: "Sri Lanka",           flag: "🇱🇰" },
  { code: "+977", name: "Nepal",               flag: "🇳🇵" },
  { code: "+33",  name: "France",              flag: "🇫🇷" },
  { code: "+49",  name: "Germany",             flag: "🇩🇪" },
  { code: "+39",  name: "Italy",               flag: "🇮🇹" },
  { code: "+34",  name: "Spain",               flag: "🇪🇸" },
  { code: "+31",  name: "Netherlands",         flag: "🇳🇱" },
  { code: "+41",  name: "Switzerland",         flag: "🇨🇭" },
  { code: "+46",  name: "Sweden",              flag: "🇸🇪" },
  { code: "+47",  name: "Norway",              flag: "🇳🇴" },
  { code: "+45",  name: "Denmark",             flag: "🇩🇰" },
  { code: "+358", name: "Finland",             flag: "🇫🇮" },
  { code: "+7",   name: "Russia",              flag: "🇷🇺" },
  { code: "+55",  name: "Brazil",              flag: "🇧🇷" },
  { code: "+52",  name: "Mexico",              flag: "🇲🇽" },
  { code: "+54",  name: "Argentina",           flag: "🇦🇷" },
  { code: "+27",  name: "South Africa",        flag: "🇿🇦" },
  { code: "+234", name: "Nigeria",             flag: "🇳🇬" },
  { code: "+254", name: "Kenya",               flag: "🇰🇪" },
  { code: "+971", name: "United Arab Emirates",flag: "🇦🇪" },
  { code: "+966", name: "Saudi Arabia",        flag: "🇸🇦" },
  { code: "+972", name: "Israel",              flag: "🇮🇱" },
  { code: "+90",  name: "Turkey",              flag: "🇹🇷" },
  { code: "+20",  name: "Egypt",               flag: "🇪🇬" },
];

const DEFAULT_COUNTRY = COUNTRIES[0]; // Thailand

// ─── Schema ───────────────────────────────────────────────────────────────────
// Mode is tracked in React state; the form just holds the raw values.

const loginSchema = z.object({
  identifier: z.string().min(1, "Required"),
  password: z.string().min(1, "Password is required"),
});
type LoginFormData = z.infer<typeof loginSchema>;

// ─── Country picker ───────────────────────────────────────────────────────────

function CountryPicker({
  value,
  onChange,
}: {
  value: { code: string; name: string; flag: string };
  onChange: (country: { code: string; name: string; flag: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selected = COUNTRIES.find((c) => c.code === value.code && c.name === value.name) ?? DEFAULT_COUNTRY;

  const filtered = useMemo(() => {
    if (!search) return COUNTRIES;
    const q = search.toLowerCase();
    return COUNTRIES.filter(
      (c) => c.name.toLowerCase().includes(q) || c.code.includes(q)
    );
  }, [search]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-28 justify-between px-3 font-mono text-sm shrink-0"
          data-testid="button-country-picker"
        >
          <span className="flex items-center gap-1.5">
            <span>{selected.flag}</span>
            <span>{selected.code}</span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search country..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>No country found.</CommandEmpty>
            <CommandGroup>
              {filtered.map((country, i) => (
                <CommandItem
                  key={`${country.code}-${country.name}-${i}`}
                  value={`${country.code}-${country.name}`}
                  onSelect={() => {
                    onChange({ code: country.code, name: country.name, flag: country.flag });
                    setOpen(false);
                    setSearch("");
                  }}
                >
                  <span className="mr-2 text-base">{country.flag}</span>
                  <span className="flex-1 text-sm">{country.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{country.code}</span>
                  {value.code === country.code && value.name === country.name && (
                    <Check className="ml-2 h-3.5 w-3.5 shrink-0" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ─── Mode toggle ──────────────────────────────────────────────────────────────

function ModeToggle({
  mode,
  onToggle,
}: {
  mode: "email" | "phone";
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      data-testid="button-toggle-login-mode"
    >
      {mode === "email" ? (
        <>
          <Phone className="h-3.5 w-3.5" />
          Use phone number instead
        </>
      ) : (
        <>
          <Mail className="h-3.5 w-3.5" />
          Use email instead
        </>
      )}
    </button>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AuthPage() {
  const { user, loginMutation } = useAuth();
  const [mode, setMode] = useState<"email" | "phone">("phone");
  const [selectedCountry, setSelectedCountry] = useState(DEFAULT_COUNTRY);

  const loginForm = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      mode: "phone",
      identifier: "",
      password: "",
    },
  });

  if (user) {
    return <Redirect to="/core/today" />;
  }

  const toggleMode = () => {
    const next = mode === "email" ? "phone" : "email";
    setMode(next);
    loginForm.reset({ identifier: "", password: "" });
  };

  const onLogin = (data: LoginFormData) => {
    if (mode === "phone") {
      const phoneIdentifier = `${selectedCountry.code}${data.identifier.replace(/^0/, "")}`;
      loginMutation.mutate({ identifier: phoneIdentifier, password: data.password });
    } else {
      loginMutation.mutate({ identifier: data.identifier, password: data.password });
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-black p-8">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <div className="flex items-center mb-2">
            <img src="/oto-logo.png" alt="OTO" className="h-10 w-auto" />
          </div>
        </CardHeader>

        <CardContent>
          <Form {...loginForm}>
            <form onSubmit={loginForm.handleSubmit(onLogin)} className="space-y-4">

              {/* Identifier field — phone or email */}
              <FormField
                control={loginForm.control}
                name="identifier"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between">
                      <FormLabel>
                        {mode === "email" ? "Email" : "Phone number"}
                      </FormLabel>
                      <ModeToggle mode={mode} onToggle={toggleMode} />
                    </div>
                    <FormControl>
                      {mode === "phone" ? (
                        <div className="flex gap-2">
                          <CountryPicker
                            value={selectedCountry}
                            onChange={(country) => {
                              setSelectedCountry(country);
                            }}
                          />
                          <Input
                            type="tel"
                            placeholder="812345678"
                            data-testid="input-login-phone"
                            className="flex-1"
                            {...field}
                          />
                        </div>
                      ) : (
                        <Input
                          type="email"
                          placeholder="name@company.com"
                          data-testid="input-login-email"
                          {...field}
                        />
                      )}
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Password */}
              <FormField
                control={loginForm.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        placeholder="Enter your password"
                        data-testid="input-login-password"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button
                type="submit"
                className="w-full"
                disabled={loginMutation.isPending}
                data-testid="button-login"
              >
                {loginMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Signing in...
                  </>
                ) : (
                  "Sign in"
                )}
              </Button>
            </form>
          </Form>
        </CardContent>

        <CardFooter className="flex justify-center">
          <Link href="/forgot-password">
            <Button variant="ghost" className="text-sm underline-offset-4 hover:underline" data-testid="link-forgot-password">
              Forgot your password?
            </Button>
          </Link>
        </CardFooter>
      </Card>
    </div>
  );
}
