require "selenium-webdriver"
port, out, lead = ARGV.shift(3)
routes = ARGV.empty? ? %w[/ /leads /leads/LEAD /call_session] : ARGV
mock = ENV.fetch("MOCK_DIR")
mocks = { "/" => "dusk-run-today.html", "/leads" => "dusk-run-command-center.html", "/leads/LEAD" => "dusk-run-lead.html", "/call_session" => "dusk-run.html" }
opts = Selenium::WebDriver::Chrome::Options.new(binary: "/usr/bin/chromium")
%w[headless=new no-sandbox disable-gpu disable-dev-shm-usage hide-scrollbars].each { |a| opts.add_argument(a) }
d = Selenium::WebDriver.for(:chrome, options: opts, service: Selenium::WebDriver::Chrome::Service.new(path: "/usr/bin/chromedriver"))
d.manage.window.resize_to(1440, 1000)
d.navigate.to "http://127.0.0.1:#{port}/session/new"
d.find_element(name: "email_address").send_keys ENV.fetch("SHOTS_EMAIL")
d.find_element(name: "password").send_keys ENV.fetch("SHOTS_PASS")
d.find_element(name: "password").submit
sleep 1.5
# accept terms if a gate appears
begin; d.find_element(css: "input[type=checkbox]").click; d.find_element(xpath: "//button[contains(.,'Accept')]").click; sleep 1.5; rescue; end
shot = ->(url, name, w) {
  d.manage.window.resize_to(w, 1000); d.navigate.to url; sleep 2
  h = [d.execute_script("return document.documentElement.scrollHeight"), 1000].max.clamp(1000, 4000)
  d.manage.window.resize_to(w, h); sleep 0.5
  d.save_screenshot(File.join(out, "#{name}-#{w}.png"))
}
routes.each do |r|
  path = r.sub("LEAD", lead.to_s); slug = r == "/" ? "today" : r.delete_prefix("/").tr("/", "_").sub(/\d+/, "id")
  [1440, 390].each { |w| shot.("http://127.0.0.1:#{port}#{path}", "app-#{slug}", w) }
  if (m = mocks[r]) then [1440, 390].each { |w| shot.("file://#{mock}/#{m}", "mock-#{slug}", w) } end
end
d.quit
