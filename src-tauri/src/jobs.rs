use std::future::Future;

/// One monotonic generation shared by playback, prefetch, and save requests.
/// Dropping an obsolete future closes its pending connection immediately.
pub struct Jobs(tokio::sync::watch::Sender<u64>);

impl Default for Jobs {
    fn default() -> Self {
        Self(tokio::sync::watch::channel(0).0)
    }
}

impl Jobs {
    pub fn advance(&self, id: u64) -> Result<(), String> {
        self.0.send_if_modified(|current| {
            if id > *current {
                *current = id;
                true
            } else {
                false
            }
        });
        self.ensure_current(id)
    }

    fn ensure_current(&self, id: u64) -> Result<(), String> {
        if *self.0.borrow() == id {
            Ok(())
        } else {
            Err("Stopped".into())
        }
    }

    pub async fn run<T>(
        &self,
        id: u64,
        operation: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        self.advance(id)?;
        let mut changes = self.0.subscribe();
        self.ensure_current(id)?;
        tokio::select! {
            biased;
            _ = changes.changed() => Err("Stopped".into()),
            result = operation => {
                self.ensure_current(id)?;
                result
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn stale_requests_cannot_revive_cancelled_jobs() {
        let jobs = Jobs::default();
        jobs.advance(2).unwrap();
        assert_eq!(jobs.advance(1).unwrap_err(), "Stopped");
        jobs.advance(2).unwrap();
    }

    #[tokio::test]
    async fn cancellation_does_not_wait_for_network_activity() {
        let jobs = Jobs::default();
        let pending = jobs.run(1, std::future::pending::<Result<(), String>>());
        let cancel = async {
            tokio::task::yield_now().await;
            jobs.advance(2).unwrap();
        };
        let (result, _) = tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(pending, cancel)
        })
        .await
        .expect("cancellation timed out");
        assert_eq!(result.unwrap_err(), "Stopped");
    }

    #[tokio::test]
    async fn prefetch_for_same_job_is_not_cancellation() {
        let jobs = Jobs::default();
        let result = jobs
            .run(1, async {
                jobs.advance(1)?;
                Ok(42)
            })
            .await;
        assert_eq!(result.unwrap(), 42);
    }
}
