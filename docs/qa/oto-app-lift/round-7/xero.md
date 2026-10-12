# Xero connection state - 13 October 2026

WORKS for the recorded unconnected state and access refusal on staging app633cae41. Administrator status returned200 with connected=false; the profit-and-loss request returned400 with Xero not connected; staff status returned403. The Analytics screen displayed Connect to Xero, captured in the inspected [unconnected screen](../../jira-comments/attachments/SCRUM-191/r7-xero-unconnected-tablet-20261013.png).

No sandbox is connected, so positive OAuth exchange and real report synchronization remain unverified on staging. No Connect or Disconnect action was invoked. Round-7 organisation ownership and replay tests are local release checks; their staged unconnected refusals remain to be rechecked after deployment.
